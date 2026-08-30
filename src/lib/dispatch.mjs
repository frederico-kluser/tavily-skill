// Central dispatch: key rotation, retries, caching and the Brave key gate.
// The CLI never talks to the provider adapter directly — it always goes
// through dispatch().
//
// v8 removed the provider fallback chain, because there is only one search
// provider. What remains is KEY rotation: several Brave keys widen the
// per-second rate budget (each key carries its own) and cover for one going
// bad. What also disappeared is the keyless tier — a research run that cannot
// reach Brave now fails loudly instead of quietly answering from Wikipedia.

import {
  loadState, saveStateAtomic, markBurned, providerHasUsableKey,
  setCooldown, cooldownActive, explainUnusable,
} from './state.mjs';
import { audit, recordUsage } from './audit.mjs';
import { cacheKey, cacheGet, cacheSet } from './cache.mjs';
import { getProvider, capabilityMap, SEARCH_PROVIDER } from './providers/index.mjs';
import { assertSearchReady } from './preflight.mjs';
import { guardExpensive } from './cost.mjs';
import { sleep } from './flags.mjs';
import { progress } from './progress.mjs';
// The version stamped onto X-Client-Name of every Brave request. It is read
// from package.json, not retyped here: a client name that lies about which
// release is talking is worse than no client name at all.
import { VERSION } from './version.mjs';

const CACHEABLE = new Set(['search']);
// After a key exhausts its 429 retries, sideline it for this long (persisted)
// so we stop hammering a rate-limited key now and on the next process run.
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.SURF_RATE_LIMIT_COOLDOWN_MS) || 60_000;

// Detect the agent harness's bash timeout from env vars. The number is the
// total time (ms) the harness will allow our process to live before SIGTERM.
// We use this to abort early with an actionable error instead of being killed
// silently. Returns Infinity when the caller has opted out of the budget
// entirely (no-limit harnesses like Pi Coding Agent core, which applies NO
// default bash timeout).
export function detectHarnessBudgetMs(flags = {}) {
  if (flags['no-budget'] || flags.noBudget || process.env.SURF_NO_TIMEOUT === '1') return Infinity;
  if (process.env.SURF_AGENT_BUDGET_MS) {
    const n = Number(process.env.SURF_AGENT_BUDGET_MS);
    if (n === 0) return Infinity; // explicit unlimited
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (process.env.BASH_DEFAULT_TIMEOUT_MS) {
    const n = Number(process.env.BASH_DEFAULT_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) return n; // Claude Code
  }
  if (process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS) {
    const n = Number(process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS);
    if (Number.isFinite(n) && n > 0) return n * 1000; // Pi
  }
  if (process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS) {
    const n = Number(process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Unknown harness — assume worst case (Copilot CLI without per-project hook).
  return 30_000;
}

export function detectHarnessName(flags = {}) {
  if (flags['no-budget'] || flags.noBudget || process.env.SURF_NO_TIMEOUT === '1') {
    return 'no-limit (--no-budget / SURF_NO_TIMEOUT)';
  }
  if (process.env.SURF_AGENT_BUDGET_MS === '0') return 'no-limit (SURF_AGENT_BUDGET_MS=0)';
  if (process.env.SURF_AGENT_BUDGET_MS) return 'override';
  if (process.env.BASH_DEFAULT_TIMEOUT_MS) return 'claude-code';
  if (process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS) return 'pi';
  if (process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS) return 'opencode';
  return 'unknown (assuming 30s — likely GH Copilot CLI without hook)';
}

export class DispatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
    this.details = details;
  }
}

// Everything about a REQUEST that can be judged without looking at the key ring
// or at the cache: the verb has to exist, and --provider has to name the one
// provider that exists. Split out of buildChain() so dispatch() can run it as
// its very first act. It used to live below the cache lookup, which meant a
// flag the tool promises to validate ('--provider tavily') was rejected only
// when the query happened to MISS the cache: on a hit the request was accepted
// and answered with Brave results. Validation of the caller's own words must be
// deterministic, so it now runs before anything is read from disk.
function assertRequestSupported(operation, flags) {
  const baseChain = capabilityMap[operation];
  if (!Array.isArray(baseChain)) {
    throw new DispatchError(
      'UnknownOperation',
      `operation '${operation}' does not exist in surf v8. Brave Search is a SERP: ` +
      `it serves 'search' only. extract, crawl, map, research and usage were removed — ` +
      `they had no Brave equivalent.`,
    );
  }

  if (flags.provider && flags.provider !== SEARCH_PROVIDER) {
    throw new DispatchError(
      'UnknownProvider',
      `--provider '${flags.provider}' does not exist in surf v8. The only search provider is '${SEARCH_PROVIDER}'.`,
    );
  }

  return baseChain;
}

function buildChain(operation, state, flags) {
  // Idempotent: dispatch() already ran this before the cache lookup. Kept here
  // so buildChain() stays correct for any other caller.
  const baseChain = assertRequestSupported(operation, flags);

  const chain = baseChain.filter(p => providerHasUsableKey(state, p));
  if (chain.length === 0) {
    const why = explainUnusable(state, baseChain[0]);
    throw new DispatchError(
      'NoProviderAvailable',
      `operation '${operation}' needs a usable ${baseChain[0]} key: ${why ? why.reason : 'none configured'}. ` +
      `${why ? why.fix : ''}`,
      { provider: baseChain[0], why },
    );
  }
  return { chain, pinned: chain.length === 1 };
}

function backoff(attempt) {
  // Capped exponential backoff with "equal jitter": half fixed + half random.
  // Jitter sharply cuts synchronized retry storms when many keys/clients hit the
  // same rate-limited provider (AWS: adding jitter "reduced our call count by
  // more than half"). https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
  const capped = Math.min(1500 * (attempt + 1) ** 2, 8000);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/** Warn once when a caller passed an argument this provider cannot honour. */
function warnUnsupportedArgs(provider, args) {
  if (!provider.supportedArgs) return;
  const ignored = Object.keys(args || {})
    .filter(k => args[k] !== undefined && args[k] !== null && args[k] !== '')
    .filter(k => !provider.supportedArgs.has(k));
  if (ignored.length) {
    progress.warn(`${provider.name}: ignoring unsupported argument(s): ${ignored.join(', ')}`);
  }
}

export async function dispatch(operation, args, flags = {}, runCtx = {}) {
  const startTs = Date.now();

  // FIRST, before the state file and before the cache: is this request even a
  // thing surf v8 can do? An unknown verb or an unknown --provider is the
  // caller's typo, and a typo must fail the same way every time — never
  // "rejected on a cache miss, honoured on a cache hit".
  assertRequestSupported(operation, flags);

  const harnessBudget = detectHarnessBudgetMs(flags);
  const harnessName = detectHarnessName(flags);
  const unlimited = !Number.isFinite(harnessBudget);
  // Reserve a cushion so we surface the error before the harness kills us.
  const cushion = unlimited ? 0 : Math.min(2000, Math.floor(harnessBudget * 0.1));

  // Library mode: caller can pass an in-memory state object to avoid touching
  // ~/.config/surf/keys.json. State mutations (burned, cooldowns) stay
  // in-memory and don't get persisted when runCtx.state._inMemory is true.
  const state = runCtx.state || await loadState();
  const persistState = !state._inMemory;
  let cachedHit = null;
  let cKey = null;

  // Cache lookup. Deliberately BEFORE the key gate: a cache hit needs no key,
  // costs no credit and touches no network, so refusing to serve it would be a
  // regression rather than a safety win.
  if (CACHEABLE.has(operation) && !flags['no-cache'] && !flags['raw-json']) {
    cKey = cacheKey('brave', operation, args);
    cachedHit = await cacheGet(cKey);
    if (cachedHit) {
      await audit({ op: operation, cache: 'hit', provider: cachedHit.provider });
      await recordUsage({ op: operation, provider: cachedHit.provider, credits: 0, cached: true });
      progress.success(`${operation} cache hit (${cachedHit.provider})`);
      return cachedHit;
    }
  }

  // Key availability. Deliberately AFTER the cache lookup (see above) and, for
  // the CLI, after bin/*'s own preflightOrExit(): by the time control reaches
  // here the request is well-formed and unanswerable from disk, so the only
  // remaining question is whether we hold a key that can answer it.
  const { chain, pinned } = buildChain(operation, state, flags);

  // THE HARD STOP. Nothing below this line runs without a Brave key we have
  // either just validated or validated recently. The common path is offline.
  await assertSearchReady(state, operation, { persist: persistState });

  guardExpensive(operation, args, chain, flags);

  const errors = [];

  for (const providerName of chain) {
    const provider = getProvider(providerName);
    if (!provider) {
      errors.push(`${providerName}: provider not registered`);
      continue;
    }
    if (!provider.supports[operation]) {
      errors.push(`${providerName}: does not support '${operation}'`);
      continue;
    }
    warnUnsupportedArgs(provider, args);

    let attempted = new Set();
    let providerExhausted = false;

    while (!providerExhausted) {
      const keyIdx = (() => {
        const p = state[providerName];
        if (!p || !p.keys.length) return -1;
        const burnedIdx = new Set(p.burned.map(b => b.index));
        const now = Date.now();
        const n = p.keys.length;
        const start = Math.max(0, Math.min(p.current || 0, n - 1));
        for (let off = 0; off < n; off++) {
          const i = (start + off) % n;
          if (attempted.has(i)) continue;
          if (burnedIdx.has(i)) continue;
          if (cooldownActive(p, i, now)) continue; // skip rate-limited keys
          return i;
        }
        return -1;
      })();
      if (keyIdx === -1) { providerExhausted = true; break; }
      attempted.add(keyIdx);

      progress.start(`${operation} → ${providerName} (key #${keyIdx})`);

      // Self-budget check: abort BEFORE the harness SIGTERMs us. Skipped
      // entirely when unlimited (--no-budget / no-limit harness like Pi).
      let remaining = Infinity;
      if (!unlimited) {
        const elapsed = Date.now() - startTs;
        remaining = harnessBudget - elapsed - cushion;
        if (remaining <= 1000) {
          throw new DispatchError(
            'LikelyAgentTimeout',
            `Operation '${operation}' would likely exceed the agent's bash timeout ` +
            `(~${Math.round(harnessBudget / 1000)}s detected, harness=${harnessName}). ` +
            `Run 'surf-research-skill project-config' in this project to raise the limit, ` +
            `or pass --no-budget if this harness has NO bash timeout (e.g. Pi core). ` +
            `Note Brave paces requests to your plan's rate limit, so a wide fan-out takes time.`,
            { harness: harnessName, budgetMs: harnessBudget, elapsedMs: elapsed },
          );
        }
      }

      const ctx = {
        key: state[providerName].keys[keyIdx],
        // Constrain HTTP timeout to whatever's left in our budget so we don't
        // sit waiting beyond what the harness will allow. When unlimited, pass
        // undefined so the provider uses its own per-request ceiling
        // (SURF_TIMEOUT_MS || 45s) — never Infinity, which Node's setTimeout
        // clamps to ~1ms and would abort the request immediately.
        timeout: unlimited
          ? (flags.timeout ? Number(flags.timeout) : undefined)
          : Math.min(flags.timeout ? Number(flags.timeout) : Infinity, remaining),
        version: VERSION,
      };

      let consecutive5xx = 0;
      let consecutive429 = 0;
      let consecutiveNetwork = 0;
      let success = null;

      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        try {
          success = await provider[operation](args, ctx);
          break;
        } catch (e) {
          const kind = e.kind || 'caller_4xx';
          await audit({
            op: operation, provider: providerName, key_index: keyIdx,
            kind, status: e.statusCode, message: (e.message || '').slice(0, 200),
          });

          // The caller's fault, not the key's. Do NOT retry, do NOT burn.
          // This branch is what stops a typo in --country from permanently
          // destroying every key in the ring: Brave answers a bad parameter
          // with 422, the same status as an invalid token, and the previous
          // version could not tell them apart.
          if (kind === 'caller_4xx' || kind === 'config_4xx' || kind === 'not_supported') throw e;

          // The PLAN lacks a feature. The key is fine and another key on the
          // same account would fail identically, so rotating is pointless.
          if (kind === 'plan_gate') throw e;

          if (kind === 'rate_limit_429') {
            consecutive429++;
            if (attempt < 2) {
              // Brave sends no Retry-After; the adapter derives the wait from
              // x-ratelimit-reset and hands it over as retryAfterMs.
              const wait = e.retryAfterMs || backoff(attempt);
              progress.retry(`${providerName} 429 — backoff ${wait}ms (attempt ${attempt + 1}/3)`);
              await sleep(wait); continue;
            }
            // Exhausted 429 retries: sideline this key on a short, persisted
            // cooldown so we skip it now and next run instead of hammering it.
            setCooldown(state, providerName, keyIdx, Date.now() + RATE_LIMIT_COOLDOWN_MS);
            if (persistState) await saveStateAtomic(state);
            break; // -> next key
          }
          if (kind === 'network') {
            consecutiveNetwork++;
            if (attempt < 2) {
              progress.retry(`${providerName} network error — backoff ${Math.round(backoff(attempt) / 2)}ms`);
              await sleep(backoff(attempt) / 2); continue;
            }
            break; // exhausted retries -> next key
          }
          if (kind === 'auth') {
            progress.warn(`${providerName} key #${keyIdx} burned (${e.statusCode || 'auth'})`);
            markBurned(state, providerName, keyIdx, String(e.statusCode || 'auth'));
            if (persistState) await saveStateAtomic(state);
            break; // next key
          }
          if (kind === 'server_5xx') {
            consecutive5xx++;
            if (consecutive5xx >= 3) {
              progress.warn(`${providerName} key #${keyIdx} sidelined (5xx x3)`);
              setCooldown(state, providerName, keyIdx, Date.now() + RATE_LIMIT_COOLDOWN_MS);
              if (persistState) await saveStateAtomic(state);
              break; // next key
            }
            if (attempt < 2) {
              progress.retry(`${providerName} 5xx — backoff ${backoff(attempt)}ms`);
              await sleep(backoff(attempt)); continue;
            }
            break;
          }
          // Unknown kind — treat as caller error to avoid masking bugs.
          throw e;
        }
      }

      if (success) {
        state.last_ok_provider = providerName;
        state[providerName].current = keyIdx;
        if (persistState) await saveStateAtomic(state);
        await recordUsage({
          op: operation,
          provider: providerName,
          key_index: keyIdx,
          credits: success.usage && success.usage.credits,
          cached: false,
          latency_ms: success.latency_ms,
        });
        if (cKey && CACHEABLE.has(operation)) {
          await cacheSet(cKey, success);
        }
        const credits = success.usage && success.usage.credits;
        progress.success(
          `${operation} ${providerName} ${success.latency_ms}ms` +
          (credits != null ? ` (${credits} credits)` : '')
        );
        return success;
      }

      errors.push(`${providerName}#${keyIdx}: ${consecutive5xx ? '5xx' : consecutive429 ? '429' : consecutiveNetwork ? 'network' : 'auth'}`);
    }

    if (pinned) break;
  }

  const why = explainUnusable(state, chain[0]);
  throw new DispatchError(
    'AllKeysExhausted',
    `'${operation}' failed on every ${chain[0]} key${errors.length ? ': ' + errors.join('; ') : ''}.` +
    (why ? ` ${why.reason} — ${why.fix}` : ''),
    { errors, why },
  );
}
