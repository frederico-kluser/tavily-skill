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

  // Batch: run sequentially, return array of envelopes
  const batches = [];
  let keylessErr = null;
  for (const q of queries) {
    try {
      const env = await dispatch('search', buildArgs(q, opts), buildFlags(opts), { state });
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
 * @returns {Promise<{operation:'search-parallel', data:{batches:Array}, error?:object, summary:object}>}
 *   `error` is present only when NOTHING succeeded because the key gate is
 *   closed; it carries the gate's code and exitCode 78. See the note at the
 *   bottom of this function for why this one entry point reports rather than
 *   rejects.
 */
export async function searchParallel(queries, opts = {}) {
  if (opts.quiet !== false) setSilent(true);

  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q, i) => (typeof q === 'string'
      ? { id: `q${i + 1}`, q, sub: null }
      : { id: (q && q.id) || `q${i + 1}`, q: q && (q.q || q.query), sub: (q && q.sub) || null }))
    .filter(it => typeof it.q === 'string' && it.q.trim());
  if (!list.length) throw new Error('searchParallel: need at least one non-empty query');

  // `subAgents` is the canonical name for "how many searches at once";
  // `concurrency` remains as a legacy alias. Brave's own rate limiter paces
  // whatever number lands here, so a value above the plan's req/s widens
  // nothing — it just queues.
  const asked = Number(opts.subAgents ?? opts.concurrency);
  const concurrency = Number.isFinite(asked) && asked > 0
    ? Math.max(1, Math.min(Math.floor(asked), 20))
    : 10;
  const state = await buildInMemoryState(opts);
  const flags = { ...buildFlags(opts), 'no-budget': opts.noBudget !== false };

  const settled = await mapPool(list, concurrency, (item) =>
    dispatch('search', buildArgs(item.q, opts), flags, { state })
  );

  const batches = list.map((item, i) => {
    const r = settled[i];
    if (r && r.ok) return { id: item.id, sub: item.sub, query: item.q, ok: true, envelope: r.value };
    const e = (r && r.error) || {};
    return { id: item.id, sub: item.sub, query: item.q, ok: false, error: { code: e.code || e.name || 'Error', message: e.message || 'unknown error' } };
  });

  // THE ONE PLACE THE EXIT-78 INVARIANT STILL DOES NOT REJECT — deliberately,
  // and against my preference. By the rule applied to search() above, a fan-out
  // that produced nothing BECAUSE there is no key is "0 sources but exit 0" and
  // should reject. It cannot yet: test/adversarial/lib-install.mjs:242-246
  // awaits this exact call bare and then asserts on the resolved summary
  // (`out.summary.failed === 2`), so a rejection takes the suite that is meant
  // to certify the fix down with it. That suite is off-limits to this change.
  //
  // What IS possible without touching it: stop the failure from being
  // anonymous. Every batch that failed for want of a key now carries the gate's
  // own verdict (BraveKeyMissing / BraveKeyBurned / …) and exitCode 78 instead
  // of the internal 'NoProviderAvailable', and when NOTHING succeeded the
  // result carries that verdict at the top level as `error`. A caller can
  // branch on the exit-78 contract instead of mistaking 0 results for an
  // answer — but it has to look, which is why this is a half-measure and not
  // the fix.
  const keylessErr = settled.find(r => r && !r.ok && isKeyless(r.error));
  let gate = null;
  if (keylessErr) {
    const g = await asGateError(state, keylessErr.error);
    gate = { code: g.code || 'Error', message: g.message, exitCode: g.exitCode };
    for (const b of batches) {
      if (!b.ok && b.error && isKeyless(b.error)) b.error = { ...gate };
    }
  }

  return {
    operation: 'search-parallel',
    data: { batches },
    ...(gate && !batches.some(b => b.ok) ? { error: gate } : {}),
    summary: {
      total: list.length,
      succeeded: batches.filter(b => b.ok).length,
      failed: batches.filter(b => !b.ok).length,
      concurrency,
    },
  };
}

function buildArgs(query, opts) {
  assertEnum('mode', opts.mode, MODES);
  assertEnum('depth', opts.depth, ['basic', 'advanced', 'fast', 'ultra-fast']);
  assertEnum('topic', opts.topic, ['general', 'news']);
  assertEnum('time', opts.time, ['day', 'week', 'month', 'year']);
  assertEnum('safesearch', opts.safesearch, ['off', 'moderate', 'strict']);
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
    timeout: opts.timeout,
    'confirm-expensive': true, // library callers know what they're doing
  };
}
