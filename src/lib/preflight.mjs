// The hard stop.
//
// surf v8 answers with Brave or it does not answer. There is no degraded tier,
// no silent fallback to a free encyclopedia, and no "0 sources but exit 0".
// If a valid Brave key cannot be identified, every command halts here with a
// message naming the exact fix, and exits 78.
//
// WHY 78: sysexits(3) EX_CONFIG. It is distinct from 1 (the operation ran and
// failed) and 2 (you typed the command wrong), so an orchestrating agent can
// branch on "the configuration is broken, retrying is pointless" without
// parsing prose. That distinction is the whole reason this is not just an
// error string.
//
// WHY IT IS AFFORDABLE TO RUN EVERY TIME: validating a Brave key costs nothing.
// A request with no `q` is rejected before it is billed — Brave documents that
// failed requests do not count against quota, and an A/B of 108 deliberately
// failing requests moved the monthly counter by exactly zero. A good key and a
// bad key both answer 422 and are told apart by `error.code`. The verdict is
// still cached for 7 days, because the probe consumes a slot in Brave's
// 1-second rate window even though it costs no money.
//
// WHAT MAY BE CACHED: only Brave saying "this token is bad". A dropped
// connection, a DNS failure, a timeout or a 5xx from Brave's own servers are
// facts about the network, not about the key — and a 7-day cache entry made
// from one of those turns a three-second wifi blip into a week of exit 78 that
// survives every reboot. Those failures are recorded NOWHERE: the key stays
// unvalidated and the next run re-probes it (for free). See resolveGate.

import {
  loadState, saveStateAtomic, cooldownActive, nextResetIso,
  getValidation, setValidation, explainUnusable, KEYS_FILE,
} from './state.mjs';
import { getProvider, SEARCH_PROVIDER, capabilityMap } from './providers/index.mjs';

export const EXIT_CONFIG = 78;

export const GATE = {
  READY: 'ready',
  MISSING: 'missing',
  BURNED: 'burned',
  COOLING: 'cooling',
  UNVALIDATED: 'unvalidated',
  INVALID: 'invalid',
  // "We could not find out." Distinct from INVALID on purpose: INVALID means
  // Brave rejected the token, UNREACHABLE means nobody answered. Only the
  // first is a fact about the key, and only the first is ever cached.
  UNREACHABLE: 'unreachable',
};

const CODE_FOR = {
  [GATE.MISSING]: 'BraveKeyMissing',
  [GATE.BURNED]: 'BraveKeyBurned',
  [GATE.COOLING]: 'BraveKeyCooling',
  [GATE.INVALID]: 'BraveKeyInvalid',
  // Same BraveKey* family, so a caller matching /^BraveKey/ still recognises it.
  [GATE.UNREACHABLE]: 'BraveKeyUnverified',
};

export class GateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.exitCode = EXIT_CONFIG;
    this.details = details;
  }
}

/**
 * The provider section as the gate is allowed to READ it.
 *
 * loadState() normalises keys.json, but the gate is also a library entry point
 * (dispatch takes runCtx.state) and every internal caller that spreads a
 * partial object reaches it too. A gate that throws is worse than a gate that
 * decides — it fails open or closed depending on who catches it — so every
 * list is coerced here, once. Reads only: writes still go through state.mjs,
 * which repairs the same fields on its own.
 */
function readProvider(state, provider) {
  const p = state && typeof state === 'object' ? state[provider] : null;
  if (!p || typeof p !== 'object') return null;
  return {
    // A non-array `keys` (a hand-edited string) has a .length, which is why the
    // emptiness check alone never caught it.
    keys: Array.isArray(p.keys) ? p.keys : [],
    burned: Array.isArray(p.burned) ? p.burned : [],
    cooldowns: Array.isArray(p.cooldowns) ? p.cooldowns : [],
  };
}

/** The burned key indices of an already-coerced section. */
function burnedIndexes(p) {
  return new Set(p.burned.filter(b => b && typeof b === 'object').map(b => b.index));
}

/**
 * Does this failed validate() prove anything about the KEY?
 *
 * Only one thing does: Brave rejecting the subscription token (kind 'auth' —
 * a 401/403/402 or a SUBSCRIPTION_TOKEN_INVALID body). Everything else —
 * 'network' (dropped connection, DNS, timeout), 'server_5xx' (Brave is down),
 * or an unattributed status from a captive portal or a corporate proxy — is
 * evidence about the path to Brave. Whitelist, not blacklist: an unknown
 * failure kind must not be able to convict a working key.
 */
function provesKeyBad(r) {
  return !!r && r.valid === false && r.kind === 'auth';
}

/**
 * What we know about this provider's keys WITHOUT touching the network.
 * Returns { verdict, index, detail } where `index` is the key to use when the
 * verdict is READY or UNVALIDATED.
 */
export function gateStatus(state, provider = SEARCH_PROVIDER) {
  const p = readProvider(state, provider);
  if (!p || !p.keys.length) {
    return { verdict: GATE.MISSING, index: -1, detail: 'no key configured' };
  }

  const burnedIdx = burnedIndexes(p);
  const now = Date.now();
  const live = p.keys.map((_, i) => i).filter(i => !burnedIdx.has(i));

  if (!live.length) {
    const b = p.burned[0] || {};
    return {
      verdict: GATE.BURNED, index: -1,
      detail: `all ${p.keys.length} key(s) burned (${b.reason || 'auth'} at ${b.at || 'unknown'}); auto-resets ${nextResetIso(b.at)}`,
    };
  }

  const ready = live.filter(i => !cooldownActive(p, i, now));
  if (!ready.length) {
    const c = (p.cooldowns || []).find(x => x.index === live[0]);
    return {
      verdict: GATE.COOLING, index: -1,
      detail: `every usable key is cooling down after a rate limit until ${c ? c.until : 'shortly'}`,
    };
  }

  // A key we have already proved good, inside the TTL, is enough.
  for (const i of ready) {
    const v = getValidation(state, provider, i);
    if (v && v.ok) return { verdict: GATE.READY, index: i, detail: `validated ${v.at}` };
  }
  // A key we have already proved BAD but which was never burned (e.g. added
  // with --skip-validate) must not be presented as merely unvalidated.
  const unproven = ready.filter(i => {
    const v = getValidation(state, provider, i);
    return !v || v.ok;
  });
  if (!unproven.length) {
    const v = getValidation(state, provider, ready[0]);
    return {
      verdict: GATE.INVALID, index: -1,
      detail: `every key failed validation (${(v && v.reason) || 'invalid token'})`,
    };
  }
  return { verdict: GATE.UNVALIDATED, index: unproven[0], detail: 'never validated' };
}

/**
 * Resolve the gate, paying for at most ONE live (free) validation.
 *
 * @param {object} state       loaded keys state (mutated in place on validation)
 * @param {string} provider
 * @param {object} [opts]
 * @param {boolean} [opts.allowLive=true]  set false for offline callers (doctor --offline)
 * @param {boolean} [opts.persist=true]    write the cached verdict back to keys.json
 * @returns {Promise<{verdict, index, detail}>}  verdict READY | INVALID | UNREACHABLE
 *   (or whatever gateStatus already decided offline)
 */
export async function resolveGate(state, provider = SEARCH_PROVIDER, opts = {}) {
  const { allowLive = true, persist = true } = opts;
  let status = gateStatus(state, provider);
  if (status.verdict !== GATE.UNVALIDATED) return status;
  if (!allowLive) return { ...status, verdict: GATE.READY, detail: 'presence only (offline check)' };

  const adapter = getProvider(provider);
  if (!adapter || typeof adapter.validate !== 'function') {
    return { ...status, verdict: GATE.READY, detail: 'provider exposes no validator' };
  }

  const p = readProvider(state, provider) || { keys: [], burned: [], cooldowns: [] };
  const burnedIdx = burnedIndexes(p);
  const now = Date.now();
  const candidates = p.keys
    .map((_, i) => i)
    .filter(i => !burnedIdx.has(i) && !cooldownActive(p, i, now));

  let lastReason = 'invalid token';
  let lastStatus = null;
  let unreachable = null;   // the last probe that never got an answer
  let recorded = false;     // did we learn anything worth writing to disk?
  for (const i of candidates) {
    const cached = getValidation(state, provider, i);
    if (cached && cached.ok) return { verdict: GATE.READY, index: i, detail: `validated ${cached.at}` };
    if (cached && !cached.ok) { lastReason = cached.reason || lastReason; continue; }

    const r = await adapter.validate(p.keys[i]);

    if (r.valid) {
      setValidation(state, provider, i, { ok: true, status: r.statusCode, reason: null });
      if (persist) { try { await saveStateAtomic(state); } catch {} }
      return { verdict: GATE.READY, index: i, detail: r.free ? 'validated live (free probe)' : 'validated live' };
    }

    if (!provesKeyBad(r)) {
      // THE ONE THAT COST A WEEK. Caching ok:false here would make gateStatus
      // answer INVALID and would make the `continue` above skip this key for
      // the whole VALIDATION_TTL_MS (7 days) — persisted, so the reboot that
      // fixes the wifi does not fix this. Record NOTHING: the key stays
      // unvalidated and the next run probes it again. Being wrong this way
      // costs one free round-trip; being wrong the other way costs a week of
      // exit 78 on a key that works.
      unreachable = {
        index: i,
        reason: r.error || r.kind || 'the probe got no answer',
        status: r.statusCode ?? null,
      };
      continue;
    }

    setValidation(state, provider, i, {
      ok: false, status: r.statusCode, reason: r.error || r.kind,
    });
    recorded = true;
    lastReason = r.error || r.kind || lastReason;
    lastStatus = r.statusCode;
  }

  // Only write when a verdict actually changed. An outage must not rewrite
  // keys.json at all — there is nothing new in it, and the write is one more
  // chance to lose a key to a concurrent writer.
  if (recorded && persist) { try { await saveStateAtomic(state); } catch {} }

  // One unjudged key outranks any number of judged-bad ones: as long as a key
  // was never actually answered for, "every key failed validation" is a claim
  // we cannot make.
  if (unreachable) {
    return {
      verdict: GATE.UNREACHABLE, index: -1, status: unreachable.status,
      detail: `could not reach ${(getProvider(provider) || {}).label || provider} to check key #${unreachable.index} `
        + `(${unreachable.reason}) — no verdict was cached, so the next run checks again`,
    };
  }
  return { verdict: GATE.INVALID, index: -1, detail: lastReason, status: lastStatus };
}

/** Human-facing text for a failed gate. One shape, reused everywhere. */
export function formatGate(verdict, detail, provider = SEARCH_PROVIDER) {
  const adapter = getProvider(provider) || {};
  const label = adapter.label || provider;
  const signup = adapter.signupUrl || '';
  const envVar = adapter.envVar || `${provider.toUpperCase()}_API_KEY`;
  const code = CODE_FOR[verdict] || 'BraveKeyMissing';

  const head = {
    [GATE.MISSING]: `surf requires a valid ${label} key and could not find one.`,
    [GATE.BURNED]: `every ${label} key on this machine is burned.`,
    [GATE.COOLING]: `every ${label} key is rate-limited right now.`,
    [GATE.INVALID]: `the configured ${label} key was rejected by the API.`,
    [GATE.UNREACHABLE]: `surf could not reach ${label} to check the key.`,
  }[verdict] || `no usable ${label} key.`;

  const fix = {
    [GATE.MISSING]: [
      `Checked: ${KEYS_FILE}, $${envVar} / $${envVar}S, ./.env`,
      `Fix:      surf-research-skill keys add --provider ${provider} <key>`,
      `          (or: surf   — the interactive setup)`,
      signup ? `Get a key: ${signup}` : '',
    ],
    [GATE.BURNED]: [
      `Fix: surf-research-skill keys reset --provider ${provider}`,
      `     Burns clear on their own at the start of the next month.`,
      `     If the key is genuinely dead, replace it: keys remove / keys add.`,
    ],
    [GATE.COOLING]: [
      `Fix: wait for the cooldown to expire, or add another ${label} key —`,
      `     each key carries its own per-second rate budget.`,
    ],
    [GATE.INVALID]: [
      `This verdict is cached (up to 7 days), so re-check it before you delete`,
      `anything — the key itself may be fine.`,
      `Fix: surf-research-skill keys reset --provider ${provider}`,
      `     Clears the cached verdict and the cooldowns, so the next command`,
      `     re-tests the key live. Testing costs nothing.`,
      `If it is rejected again after that, the key really is dead:`,
      `     surf-research-skill keys remove --provider ${provider} <index>`,
      `     then add a working one.`,
      signup ? `Get a key: ${signup}` : '',
    ],
    [GATE.UNREACHABLE]: [
      `Nothing was decided about your key and nothing was cached: the probe`,
      `never got an answer, so the next command tests it again for free.`,
      `Fix: check this machine's network (DNS, proxy, VPN, captive portal),`,
      `     or wait out the ${label} outage, then re-run the same command.`,
      `     surf doctor   — re-checks the gate without spending a search.`,
      `Do NOT remove the key on account of this message. It was never judged.`,
    ],
  }[verdict] || [];

  return {
    code,
    text: [
      `❌ Error [${code}]: ${head}`,
      detail ? `   Detail: ${detail}` : '',
      ...fix,
      '',
      `surf v8 is ${label}-only by design: it returns a cited answer from ${label}, or this error.`,
      `It will never quietly answer from somewhere else.`,
    ].filter(Boolean).join('\n'),
  };
}

/**
 * The gate itself. Throws GateError (exit 78) unless a usable key exists.
 * Safe to call repeatedly: the cached verdict makes the common path offline.
 */
export async function assertProviderReady(state, provider = SEARCH_PROVIDER, opts = {}) {
  const res = await resolveGate(state, provider, opts);
  if (res.verdict === GATE.READY) return res;
  const { code, text } = formatGate(res.verdict, res.detail, provider);
  throw new GateError(code, text, { verdict: res.verdict, provider, detail: res.detail });
}

/** Gate for one dispatch operation, driven by the capability chain. */
export async function assertSearchReady(state, operation, opts = {}) {
  const chain = capabilityMap[operation];
  if (!Array.isArray(chain) || !chain.length) return null;
  return assertProviderReady(state, chain[0], opts);
}

/**
 * Bin-level entry point: load state, gate, and either return it or print the
 * canonical message and exit 78. Every executable calls this before doing any
 * work, so the halt arrives in milliseconds rather than after an LLM plan call.
 */
export async function preflightOrExit({ allowLive = true } = {}) {
  let state;
  try {
    state = await loadState();
  } catch (e) {
    process.stderr.write(`❌ Error [BraveKeyMissing]: could not read ${KEYS_FILE}: ${e.message}\n`);
    process.exit(EXIT_CONFIG);
  }
  try {
    await assertProviderReady(state, SEARCH_PROVIDER, { allowLive });
    return state;
  } catch (e) {
    if (e instanceof GateError) {
      process.stderr.write(e.message + '\n');
      process.exit(EXIT_CONFIG);
    }
    throw e;
  }
}
