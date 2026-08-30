// Library wrapper for `search`. Wraps dispatch + key discovery + the key gate.
//
// THE EXIT-78 INVARIANT, ON THE LIBRARY PATH.
//
// src/index.mjs promises the caller: "if no valid Brave key can be identified,
// the promise rejects with a GateError whose `code` is one of BraveKeyMissing /
// BraveKeyBurned / BraveKeyCooling / BraveKeyInvalid". A binary gets that from
// bin/*'s preflightOrExit(), which halts with exit 78 before any work. A
// library caller has no bin, so this file is where that promise is kept.
//
// dispatch() answers "no usable key" with DispatchError/NoProviderAvailable —
// true, but it carries no exitCode and does not name which of the four states
// the ring is in, so a wrapper cannot honour the contract. Every entry point
// below therefore re-asks the gate, OFFLINE, whenever dispatch failed for want
// of a key, and rethrows what the gate says.
//
// WHY THE GATE IS ASKED AFTER dispatch() AND NOT BEFORE: a cache hit needs no
// key, costs no credit and touches no network (dispatch.mjs:169-181 argues the
// point). Gating ahead of dispatch would refuse to serve an answer we already
// have. Asking afterwards keeps that path alive and still leaves a keyless
// search costing exactly zero requests: the gate is consulted with
// allowLive:false, so it never probes.

import { dispatch } from '../dispatch.mjs';
import { mapPool } from '../pool.mjs';
import { buildInMemoryState } from '../../env.mjs';
import { setSilent } from '../progress.mjs';
import { assertEnum } from '../flags.mjs';
import { MODES } from '../providers/brave.mjs';
import { assertSearchReady, GateError } from '../preflight.mjs';

/** Did this failure mean "there is no key I can use", as opposed to anything else? */
function isKeyless(e) {
  return !!e && e.code === 'NoProviderAvailable';
}

/**
 * Translate a keyless dispatch failure into the GateError index.mjs promises.
 *
 * allowLive:false — this only EXPLAINS a failure that already happened offline,
 * so it must not spend a Brave request. persist:false — the library's state is
 * in-memory; nothing here may write ~/.config/surf/keys.json.
 *
 * If the gate disagrees (it says READY while dispatch said otherwise), the
 * original error is returned untouched rather than swallowed.
 */
async function asGateError(state, original) {
  try {
    await assertSearchReady(state, 'search', { allowLive: false, persist: false });
  } catch (e) {
    if (e instanceof GateError) return e;
    return e;
  }
  return original;
}

/**
 * Web search.
 *
 * @param {string|string[]} query - single query or array (batch)
 * @param {object} [opts]
 * @param {string|string[]} [opts.braveKey|opts.braveKeys]
 * @param {'fast'|'normal'|'slow'} [opts.mode='normal'] - results per query (5/10/20)
 * @param {number} [opts.max=5]
 * @param {string} [opts.topic] - 'general' | 'news'
 * @param {string} [opts.time] - 'day' | 'week' | 'month' | 'year'
 * @param {string|string[]} [opts.domains]
 * @param {string|string[]} [opts.excludeDomains]
 * @param {string} [opts.country]
 * @param {string} [opts.freshness] - Brave freshness ('pd'|'pw'|'pm'|'py'|'YYYY-MM-DDtoYYYY-MM-DD')
 * @param {number} [opts.offset] - page index, 0..9 (Brave caps pagination here)
 * @param {string} [opts.goggles] - Goggles URL for custom re-ranking
 * @param {boolean} [opts.noCache=false]
 * @param {boolean} [opts.noBudget=true] - skip the harness self-budget abort
 *   (library default: no self-budget; set false to re-enable — same contract
 *   searchParallel() documents)
 * @param {boolean} [opts.quiet=true] - silence stderr progress logs (library default)
 * @returns {Promise<object>} normalized envelope { provider, operation, data, usage, latency_ms, raw }
 *   For an array of 2+ queries: { operation:'search-batch', data:{batches}, summary }.
 * @throws {GateError} when no usable Brave key can be identified — `code` is one
 *   of BraveKeyMissing / BraveKeyBurned / BraveKeyCooling / BraveKeyInvalid and
 *   `exitCode` is 78 (sysexits EX_CONFIG). A batch rejects the same way when the
 *   missing key is why EVERY query failed; a batch with any survivor resolves.
 *   A cached query is still answered without a key: a hit costs no credit.
 */
export async function search(query, opts = {}) {
  if (opts.quiet !== false) setSilent(true);

  const queries = Array.isArray(query) ? query : [query];
  if (queries.length === 0 || queries.some(q => typeof q !== 'string' || !q.trim())) {
    throw new Error('search: query must be a non-empty string or array of strings');
  }

  const state = await buildInMemoryState(opts);

  if (queries.length === 1) {
    try {
      return await dispatch('search', buildArgs(queries[0], opts), buildFlags(opts), { state });
    } catch (e) {
      // buildArgs() throws FLAG_USAGE from inside this try on purpose: a usage
      // error is the caller's, and must not be repainted as a gate failure.
      throw isKeyless(e) ? await asGateError(state, e) : e;
    }
  }

  // Batch: run sequentially, return array of envelopes.
  //
  // A usage error is the CALLER'S, not the search's: buildArgs() validates
  // every enum, so the validation runs ONCE here, before the first fetch. An
  // invalid option then throws FLAG_USAGE up front instead of being repainted
  // as "the search failed" on every item — and costs zero requests. The
  // per-item args are a fresh copy of the validated base, so dispatch never
  // sees a shared object.
  assertArgs(opts);
  const flags = buildFlags(opts);
  const baseArgs = buildArgs(queries[0], opts);
  const batches = [];
  let keylessErr = null;
  for (const q of queries) {
    try {
      const env = await dispatch('search', { ...baseArgs, query: q }, flags, { state });
      batches.push({ query: q, ok: true, envelope: env });
    } catch (e) {
      if (isKeyless(e)) keylessErr = keylessErr || e;
      batches.push({ query: q, ok: false, error: { code: e.code || 'Error', message: e.message } });
    }
  }
  // "0 sources but exit 0" is the exact outcome preflight.mjs:3-4 exists to
  // prevent. A batch that produced nothing BECAUSE there is no key is that
  // outcome wearing a resolved promise, so it rejects instead. A batch that
  // merely failed (bad flag, 5xx, one dead query) still resolves with its
  // per-item verdicts — partial failure tolerance is the point of the shape.
  if (keylessErr && !batches.some(b => b.ok)) throw await asGateError(state, keylessErr);
  return {
    operation: 'search-batch',
    data: { batches },
    summary: {
      total: queries.length,
      succeeded: batches.filter(b => b.ok).length,
      failed: batches.filter(b => !b.ok).length,
    },
  };
}

/**
 * Parallel web search — fans out many queries concurrently with a bounded
 * worker pool (partial-failure tolerant). Unlike `search([...])` (which runs
 * sequentially), this runs up to `opts.subAgents` (default 10) at once — paced
 * by the shared Brave rate limiter, so it never outruns your plan.
 *
 * @param {Array<string|{q?:string,query?:string,id?:string,sub?:string}>} queries
 * @param {object} [opts] - same as search(), plus:
 * @param {number} [opts.subAgents=10] - simultaneous searches (alias: concurrency)
 * @param {boolean} [opts.noBudget=true] - library default: no self-budget abort
 *   (library callers aren't under an agent bash timeout). Set false to re-enable.
 * @returns {Promise<{operation:'search-parallel', data:{batches:Array}, summary:object}>}
 * @throws {GateError} when the fan-out produced NOTHING because there is no
 *   usable key — `code` is one of BraveKeyMissing / BraveKeyBurned /
 *   BraveKeyCooling / BraveKeyInvalid and `exitCode` is 78 (sysexits
 *   EX_CONFIG), the same contract the sequential batch enforces. A fan-out
 *   with any survivor (a cache hit needs no key) still resolves; its keyless
 *   batch failures then carry the gate's own verdict and exitCode 78.
 */
export async function searchParallel(queries, opts = {}) {
  if (opts.quiet !== false) setSilent(true);

  // Caller-supplied ids are a keying contract: two batches sharing one id
  // would silently drop an entry for any consumer indexing by id. Every id is
  // made unique up front — first claim keeps the base, later claims get a
  // `#2`, `#3`, … suffix — the same design frontier.mjs uses for node ids.
  const usedIds = new Set();
  const takeId = (wanted) => {
    const base = String(wanted == null ? '' : wanted).trim() || `q${usedIds.size + 1}`;
    if (!usedIds.has(base)) { usedIds.add(base); return base; }
    let n = 2;
    while (usedIds.has(`${base}#${n}`)) n += 1;
    const id = `${base}#${n}`;
    usedIds.add(id);
    return id;
  };

  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q, i) => (typeof q === 'string'
      ? { id: takeId(`q${i + 1}`), q, sub: null }
      : { id: takeId((q && q.id) || `q${i + 1}`), q: q && (q.q || q.query), sub: (q && q.sub) || null }))
    .filter(it => typeof it.q === 'string' && it.q.trim());
  if (!list.length) throw new Error('searchParallel: need at least one non-empty query');

  // Usage errors are the caller's, and must land BEFORE the first fetch: an
  // invalid enum throwing inside a mapPool worker would read as "the search
  // failed" (and pay for the siblings). Validation runs once, up front.
  assertArgs(opts);
  const flags = buildFlags(opts);
  const baseArgs = buildArgs(list[0].q, opts);

  // `subAgents` is the canonical name for "how many searches at once";
  // `concurrency` remains as a legacy alias. Brave's own rate limiter paces
  // whatever number lands here, so a value above the plan's req/s widens
  // nothing — it just queues.
  const asked = Number(opts.subAgents ?? opts.concurrency);
  // C1: an explicit `subAgents: 0` means "no fan-out" — the caller asked for
  // sequential, not for the default — so 0 downs to the minimum width of 1,
  // the way the orchestrator's knob clamps a sub-minimum request to the
  // minimum. Only an ABSENT or non-finite width (or a negative one, which the
  // suite pins as documented default behaviour) falls back to 10.
  const concurrency = Number.isFinite(asked) && asked > 0
    ? Math.max(1, Math.min(Math.floor(asked), 20))
    : (asked === 0 ? 1 : 10);
  const state = await buildInMemoryState(opts);

  // Duplicate queries within one fan-out are ONE search, not several: the
  // caller still receives one batch entry PER INPUT (each with its own id), but
  // the wire sees each distinct query once — "identical" three times must not
  // spend three credits. Traffic is deduped, never the result shape.
  const uniq = [];
  const repOf = new Map(); // item's q -> index into `uniq`
  for (const it of list) {
    if (repOf.has(it.q)) continue;
    repOf.set(it.q, uniq.length);
    uniq.push(it);
  }

  const settled = await mapPool(uniq, concurrency, (item) =>
    dispatch('search', { ...baseArgs, query: item.q }, flags, { state })
  );

  const batches = list.map((item) => {
    const r = settled[repOf.get(item.q)];
    if (r && r.ok) return { id: item.id, sub: item.sub, query: item.q, ok: true, envelope: r.value };
    const e = (r && r.error) || {};
    return { id: item.id, sub: item.sub, query: item.q, ok: false, error: { code: e.code || e.name || 'Error', message: e.message || 'unknown error' } };
  });

  // THE EXIT-78 INVARIANT, ENFORCED (G4). By the same rule search() applies to
  // its sequential batch, a fan-out that produced nothing BECAUSE there is no
  // key is "0 sources but exit 0" — the exact outcome preflight.mjs:3-4 exists
  // to prevent — so it rejects on the gate, carrying the gate's own verdict
  // (BraveKeyMissing / BraveKeyBurned / …) and exitCode 78. The suite reads
  // both outcomes (settle()): the resolving reading for the cached regime, the
  // rejecting one for the keyless regime. A fan-out with any survivor (a cache
  // hit needs no key and costs no credit) still resolves; its keyless batch
  // failures are repainted with the gate's verdict instead of the internal
  // 'NoProviderAvailable'.
  const keylessErr = settled.find(r => r && !r.ok && isKeyless(r.error));
  if (keylessErr) {
    const g = await asGateError(state, keylessErr.error);
    if (!batches.some(b => b.ok)) throw g;
    for (const b of batches) {
      if (!b.ok && b.error && isKeyless(b.error)) b.error = { code: g.code || 'Error', message: g.message, exitCode: g.exitCode };
    }
  }

  return {
    operation: 'search-parallel',
    data: { batches },
    summary: {
      total: list.length,
      succeeded: batches.filter(b => b.ok).length,
      failed: batches.filter(b => !b.ok).length,
      concurrency,
    },
  };
}

/**
 * Every enum the library validates, as one step. Run it BEFORE the first
 * dispatch so a usage error cannot be mistaken for a failed search (and
 * cannot spend quota on the siblings).
 */
function assertArgs(opts) {
  assertEnum('mode', opts.mode, MODES);
  assertEnum('depth', opts.depth, ['basic', 'advanced', 'fast', 'ultra-fast']);
  assertEnum('topic', opts.topic, ['general', 'news']);
  assertEnum('time', opts.time, ['day', 'week', 'month', 'year']);
  assertEnum('safesearch', opts.safesearch, ['off', 'moderate', 'strict']);
}

function buildArgs(query, opts) {
  assertArgs(opts);
  return {
    query,
    // 'fast' | 'normal' | 'slow' → 5 / 10 / 20 results.
    mode: opts.mode,
    // Legacy alias, still honoured. NOTE: no implicit default is injected here
    // any more. Injecting depth:'advanced' when the caller said nothing meant
    // the library silently ran every search at the widest (and most expensive)
    // tier while the docs promised 'normal'.
    depth: opts.depth,
    max: opts.max,
    topic: opts.topic,
    time: opts.time,
    startDate: opts.startDate,
    endDate: opts.endDate,
    domains: opts.domains,
    excludeDomains: opts.excludeDomains,
    country: opts.country,
    searchLang: opts.searchLang,
    uiLang: opts.uiLang,
    safesearch: opts.safesearch,
    freshness: opts.freshness,
    offset: opts.offset,
    resultFilter: opts.resultFilter,
    goggles: opts.goggles,
    extraSnippets: opts.extraSnippets,
  };
}

function buildFlags(opts) {
  return {
    provider: opts.provider,
    'no-cache': opts.noCache,
    // The library's default is NO self-budget abort: a library caller is not
    // under an agent bash timeout. SearchParallel() already documented this
    // contract; search() now honours the same flag (B1) instead of dying with
    // LikelyAgentTimeout inside someone else's harness budget.
    'no-budget': opts.noBudget !== false,
    timeout: opts.timeout,
    'confirm-expensive': true, // library callers know what they're doing
  };
}
