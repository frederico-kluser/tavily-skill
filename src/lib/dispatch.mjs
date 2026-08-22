// Central dispatch: provider+key fallback for every operation. The CLI never
// talks to provider adapters directly — it always goes through dispatch().

import {
  loadState, saveStateAtomic, markBurned, providerHasUsableKey,
  nextUsableKeyIndex, setCooldown, cooldownActive, PROVIDERS as PROVIDER_NAMES,
} from './state.mjs';
import { audit, recordUsage } from './audit.mjs';
import { cacheKey, cacheGet, cacheSet } from './cache.mjs';
import { getProvider, capabilityMap, providerFromRequestId, KEYLESS_PROVIDERS } from './providers/index.mjs';
import { guardExpensive } from './cost.mjs';
import { sleep } from './flags.mjs';
import { progress } from './progress.mjs';

const CACHEABLE = new Set(['search', 'extract', 'map']);
const VERSION = '7.0.0';
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
  // Explicit "no limit": --no-budget flag, SURF_NO_TIMEOUT=1, or
  // SURF_AGENT_BUDGET_MS=0. Disables the self-budget abort below and lets each
  // request fall back to the provider's own per-request ceiling
  // (SURF_TIMEOUT_MS || 45s). Use only when the harness will NOT kill long
  // calls — otherwise the call dies silently to SIGTERM.
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

function buildChain(operation, state, flags) {
  if (operation === 'research-poll') {
    const decoded = providerFromRequestId(flags.__requestId);
    if (!decoded) throw new DispatchError('BAD_REQUEST_ID', `unknown request_id prefix in '${flags.__requestId}'`);
    if (!providerHasUsableKey(state, decoded.provider)) {
      throw new DispatchError(
        'NoUsableKeyForRequestId',
        `request_id belongs to provider '${decoded.provider}', which has no usable keys; run "surf-research-skill keys add --provider ${decoded.provider} <key>" and retry`
      );
    }
    return { chain: [decoded.provider], pinned: true, decoded };
  }

  if (operation === 'usage') {
    const provider = flags.provider;
    if (!provider) throw new DispatchError('UsageNeedsProvider', `'usage' requires --provider tavily|parallel`);
    if (!providerHasUsableKey(state, provider)) {
      throw new DispatchError('NoUsableKey', `provider '${provider}' has no usable keys`);
    }
    return { chain: [provider], pinned: true };
  }

  // Keyless path: the standalone surf-free-skill sets flags.keyless to run a
  // free, no-API-key search over wikipedia → ddg. It never touches keyed
  // providers or keys.json, and is the ONLY way keyless providers are reached
  // (they are not in any capabilityMap chain).
  if (flags.keyless) {
    if (operation !== 'search') {
      throw new DispatchError('KeylessSearchOnly', `keyless mode only supports 'search' (got '${operation}')`);
    }
    const kc = [...KEYLESS_PROVIDERS];
    if (flags.provider) {
      if (!KEYLESS_PROVIDERS.has(flags.provider)) {
        throw new DispatchError('NotKeyless', `--provider '${flags.provider}' is not keyless (use: ${kc.join(', ')})`);
      }
      return { chain: [flags.provider], pinned: true };
    }
    return { chain: kc, pinned: false };
  }

  const baseChain = capabilityMap[operation];
  if (!Array.isArray(baseChain)) {
    throw new DispatchError('UnknownOperation', `operation '${operation}' is not registered`);
  }

  // Keyless providers (wikipedia/ddg) always survive the filter — they need no key,
  // so a `search` chain is never empty and NoProviderAvailable can't fire for it.
  // Keyed providers must still have a usable (non-burned) key.
  let chain = baseChain.filter(p => KEYLESS_PROVIDERS.has(p) || providerHasUsableKey(state, p));

  if (flags.provider) {
    if (!baseChain.includes(flags.provider)) {
      throw new DispatchError('NotCapable',
        `provider '${flags.provider}' does not support '${operation}' (supported: ${baseChain.join(', ')})`);
    }
    // Keyless providers (wikipedia/ddg) can be pinned without a key.
    if (!KEYLESS_PROVIDERS.has(flags.provider) && !providerHasUsableKey(state, flags.provider)) {
      throw new DispatchError('NoUsableKey', `provider '${flags.provider}' has no usable keys for '${operation}'`);
    }
    return { chain: [flags.provider], pinned: true };
  }

  if (chain.length === 0) {
    throw new DispatchError(
      'NoProviderAvailable',
      `operation '${operation}' requires one of [${baseChain.join(', ')}]; run "surf-research-skill keys add --provider <name> <key>"`
    );
  }

  // Promote last_ok_provider to the front when it is still in the filtered chain.
  if (state.last_ok_provider && chain.includes(state.last_ok_provider)) {
    chain = [state.last_ok_provider, ...chain.filter(x => x !== state.last_ok_provider)];
  }

  if (flags['no-fallback'] || flags.noFallback) {
    return { chain: [chain[0]], pinned: true };
  }

  return { chain, pinned: false };
}

function backoff(attempt) {
  // Capped exponential backoff with "equal jitter": half fixed + half random.
  // Jitter sharply cuts synchronized retry storms when many keys/clients hit the
  // same rate-limited provider (AWS: adding jitter "reduced our call count by
  // more than half"). https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
  const capped = Math.min(1500 * (attempt + 1) ** 2, 8000);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

export async function dispatch(operation, args, flags = {}, runCtx = {}) {
  const startTs = Date.now();
  const harnessBudget = detectHarnessBudgetMs(flags);
  const harnessName = detectHarnessName(flags);
  const unlimited = !Number.isFinite(harnessBudget);
  // Reserve a cushion so we surface the error before the harness kills us.
  const cushion = unlimited ? 0 : Math.min(2000, Math.floor(harnessBudget * 0.1));

  // Library mode: caller can pass an in-memory state object to avoid touching
  // ~/.config/surf/keys.json. State mutations (last_ok_provider, burned) stay
  // in-memory and don't get persisted when runCtx.state._inMemory is true.
  const state = runCtx.state || await loadState();
  const persistState = !state._inMemory;
  let cachedHit = null;
  let cKey = null;

  // Cache lookup (only for cacheable, only when not forced/raw/no-cache).
  if (CACHEABLE.has(operation) && !flags['no-cache'] && !flags['raw-json'] && !flags.provider) {
    cKey = cacheKey('any', operation, args);
    cachedHit = await cacheGet(cKey);
    if (cachedHit) {
      await audit({ op: operation, cache: 'hit', provider: cachedHit.provider });
      await recordUsage({ op: operation, provider: cachedHit.provider, credits: 0, cached: true });
      progress.success(`${operation} cache hit (${cachedHit.provider})`);
      return cachedHit;
    }
  }

  const { chain, pinned, decoded } = buildChain(operation, state, flags);

  // Cost guard runs AFTER chain build, so NoProviderAvailable and
  // bad-input errors surface before users see a misleading credit warning.
  if (operation !== 'research-poll' && operation !== 'usage') {
    guardExpensive(operation, args, chain, flags);
  }

  const errors = [];

  for (const providerName of chain) {
    const provider = getProvider(providerName);
    if (!provider) {
      errors.push(`${providerName}: provider not registered`);
      continue;
    }
    if (operation !== 'research-poll' && !provider.supports[operation]) {
      errors.push(`${providerName}: does not support '${operation}'`);
      continue;
    }

    let attempted = new Set();
    let providerExhausted = false;
    // Keyless providers (wikipedia/ddg) have no keys / no state slot: run exactly one
    // synthetic iteration with an undefined ctx.key.
    const isKeyless = KEYLESS_PROVIDERS.has(providerName);
    let keylessDone = false;

    while (!providerExhausted) {
      let keyIdx;
      if (isKeyless) {
        if (keylessDone) { providerExhausted = true; break; }
        keylessDone = true;
        keyIdx = -1; // sentinel: no key
      } else {
        keyIdx = (() => {
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
      }

      progress.start(`${operation} → ${providerName} (${isKeyless ? 'keyless' : 'key #' + keyIdx})`);

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
            `pass --no-budget if this harness has NO bash timeout (e.g. Pi core), ` +
            `or use 'research-start' + 'research-poll' for long jobs.`,
            { harness: harnessName, budgetMs: harnessBudget, elapsedMs: elapsed },
          );
        }
      }

      const ctx = {
        key: isKeyless ? undefined : state[providerName].keys[keyIdx],
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

      const callArgs = operation === 'research-poll' && decoded
        ? { ...args, providerRunId: decoded.providerRunId }
        : args;

      let consecutive5xx = 0;
      let consecutive429 = 0;
      let consecutiveNetwork = 0;
      let success = null;

      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        try {
          const result = await provider[operation](callArgs, ctx);
          success = result;
          break;
        } catch (e) {
          const kind = e.kind || 'caller_4xx';
          await audit({
            op: operation, provider: providerName, key_index: keyIdx,
            kind, status: e.statusCode, message: (e.message || '').slice(0, 200),
          });

          if (kind === 'caller_4xx' || kind === 'not_supported') {
            // Keyed provider + bad input: don't retry or fallback. But a KEYLESS
            // fallback that 4xxs (e.g. a bad optional env key or an upstream
            // block) must NOT abort the chain — fall through to the next provider.
            if (isKeyless) break;
            throw e;
          }
          if (kind === 'rate_limit_429') {
            consecutive429++;
            if (attempt < 2) {
              progress.retry(`${providerName} 429 — backoff ${backoff(attempt)}ms (attempt ${attempt + 1}/3)`);
              await sleep(backoff(attempt)); continue;
            }
            // Exhausted 429 retries: sideline this key on a short, persisted
            // cooldown so we skip it now and next run instead of hammering it.
            if (!isKeyless) {
              setCooldown(state, providerName, keyIdx, Date.now() + RATE_LIMIT_COOLDOWN_MS);
              if (persistState) await saveStateAtomic(state);
            }
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
            if (!isKeyless) {
              progress.warn(`${providerName} key #${keyIdx} burned (${e.statusCode || 'auth'})`);
              markBurned(state, providerName, keyIdx, String(e.statusCode || 'auth'));
              if (persistState) await saveStateAtomic(state);
            }
            break; // next key
          }
          if (kind === 'server_5xx') {
            consecutive5xx++;
            if (consecutive5xx >= 3) {
              if (!isKeyless) {
                progress.warn(`${providerName} key #${keyIdx} burned (5xx x3)`);
                markBurned(state, providerName, keyIdx, '5xx');
                if (persistState) await saveStateAtomic(state);
              }
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
        // Keyless providers never write state: no key to remember, and we must
        // NOT set last_ok_provider (that would promote the free tier ahead of the
        // user's paid providers on the next request).
        if (!isKeyless) {
          state.last_ok_provider = providerName;
          state[providerName].current = keyIdx;
          if (persistState) await saveStateAtomic(state);
        }
        await recordUsage({
          op: operation,
          provider: providerName,
          key_index: isKeyless ? undefined : keyIdx,
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

      // No success on this key; record summary and loop to next key.
      errors.push(`${providerName}${isKeyless ? '' : '#' + keyIdx}: ${consecutive5xx ? '5xx' : consecutive429 ? '429' : consecutiveNetwork ? 'network' : 'auth'}`);
    }

    if (pinned) break;
  }

  throw new DispatchError(
    'AllProvidersExhausted',
    `operation '${operation}' failed on every provider/key${errors.length ? ': ' + errors.join('; ') : ''}`,
    { errors },
  );
}
