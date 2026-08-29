// Brave Search adapter — the ONLY search backend in this package.
//
// Endpoint:  GET https://api.search.brave.com/res/v1/web/search
// Auth:      header `X-Subscription-Token: <key>`  (NOT Bearer, NOT ?apikey=)
//
// WHAT BRAVE ACTUALLY GIVES YOU, verified against the live API on 2026-08-29
// (these are the facts the rest of this file is shaped around):
//
//   · Pagination is hard-capped: `count` 1..20, `offset` 0..9 — and `offset` is
//     a PAGE index, not a result index. Both are server-enforced with 422.
//     Depth therefore comes from asking DIFFERENT questions, never from paging
//     deeper. Gate any next page on `query.more_results_available`, which is
//     ABSENT (not false) once the well runs dry.
//   · There is no page content. `web.results[].description` is one snippet;
//     `extra_snippets` adds up to five more and is the single biggest quality
//     lever available here. It is plan-gated and, when unavailable, is SILENTLY
//     OMITTED rather than erroring — so a missing array is a plan signal, never
//     a failure.
//   · `/web/search` returns NO synthesized answer. The `summarizer` block only
//     appears when `summary=1` is sent AND the plan includes it, and even then
//     it is an opaque handle that needs a second call to /summarizer/search at
//     a much lower rate limit. We do not pretend otherwise.
//   · Dates: `page_age` is ISO-8601, `age` is a display string ("2 days ago").
//     Only the ISO one may reach an LLM prompt.
//   · Errors are discriminated by `error.code`, NOT by HTTP status — an invalid
//     token answers 422, the same status as a bad parameter. See mapError.
//   · Rate limiting is a 1-second sliding window counted ON ARRIVAL, with no
//     Retry-After header. Pacing lives in ../ratelimit.mjs.
//
// Operators (site:, filetype:, quotes, -exclusions) go INSIDE `q`, which is
// capped at 400 characters / 50 words.

import { compactObject, intOr, splitList } from '../flags.mjs';
import { stripHtml } from '../html.mjs';
import { acquireSlot, learnFromHeaders, learnFromBody, resetDelayMs } from '../ratelimit.mjs';
import { progress } from '../progress.mjs';

const BASE = process.env.SURF_BRAVE_API_BASE || 'https://api.search.brave.com/res/v1';
const DEFAULT_TIMEOUT = Number(process.env.SURF_TIMEOUT_MS) || 45000;

// Server-enforced ceilings. Do not raise these hoping for more.
export const MAX_COUNT = 20;
export const MAX_OFFSET = 9;
export const MAX_QUERY_CHARS = 400;
export const MAX_QUERY_WORDS = 50;

// Mode → results per request. Brave has no native depth tiers, so the tier is
// expressed as breadth: how many results one question is worth.
const MODE_TO_COUNT = { fast: 5, normal: 10, slow: 20 };
export const MODES = ['fast', 'normal', 'slow'];

// --time → Brave `freshness`.
const TIME_TO_FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

export const braveProvider = {
  name: 'brave',
  label: 'Brave Search',
  signupUrl: 'https://api-dashboard.search.brave.com',
  envVar: 'BRAVE_API_KEY',
  docs: 'references/brave-api.md',
  supports: { search: true },
  // Every argument this adapter actually consumes. dispatch warns about
  // anything else so a flag can never be silently ignored again.
  supportedArgs: new Set([
    'query', 'mode', 'depth', 'max', 'offset', 'country', 'searchLang',
    'uiLang', 'safesearch', 'goggles', 'resultFilter', 'spellcheck',
    'time', 'startDate', 'endDate', 'freshness', 'topic',
    'domains', 'excludeDomains', 'extraSnippets',
  ]),
  search,
  validate,
  mapError,
};

function buildHeaders(key, version) {
  return {
    'X-Subscription-Token': key,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
    'X-Client-Name': `surf-agent-skill/${version || '8.0.0'}`,
  };
}

async function doFetch(path, params, ctx, { pace = true } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue; // never serialise NaN
    url.searchParams.set(k, String(v));
  }

  // Brave counts requests on arrival over a 1-second window shared by every
  // surf process on this machine. Take a slot before opening the socket.
  if (pace) {
    const slot = await acquireSlot(ctx.key);
    if (slot.paced && slot.waitedMs > 250) {
      progress.info(`brave: paced ${slot.waitedMs}ms (plan allows ${slot.rps} req/s)`);
    }
  }

  const timeout = ctx.timeout || DEFAULT_TIMEOUT;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(ctx.key, ctx.version),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    // Learn this key's real plan limits from the response. 422s carry no
    // rate-limit headers, which learnFromHeaders treats as "nothing to learn".
    await learnFromHeaders(ctx.key, res.headers);
    // A 429 body carries the whole plan inline (plan name, rate_limit,
    // quota_limit, quota_current) and is not billed — the cheapest plan probe
    // there is.
    if (res.status === 429) await learnFromBody(ctx.key, data);
    return { status: res.status, ok: res.ok, data, headers: res.headers, latency_ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError' || /timeout/i.test(e.message)) {
      throw Object.assign(new Error(`Brave request exceeded ${timeout}ms`), { kind: 'network' });
    }
    throw Object.assign(new Error(`Brave network error: ${e.message}`), { kind: 'network' });
  }
}

/**
 * Classify a Brave error response.
 *
 * THE IMPORTANT PART: HTTP status alone cannot tell an invalid key from a bad
 * parameter — both answer 422. Branching on status (as this adapter used to)
 * burned every key in the ring the first time someone typed `--country zzz`.
 * `error.code` is the real discriminator, and it was verified live:
 *
 *   422 SUBSCRIPTION_TOKEN_INVALID  → the key is bad          → burn it
 *   422 VALIDATION                  → the caller is bad       → do NOT burn
 *   400 OPTION_NOT_IN_PLAN          → the PLAN lacks a feature → do NOT burn
 *
 * Note OPTION_NOT_IN_PLAN also carries meta.component === 'authentication',
 * so branching on that field instead would burn a perfectly good key.
 */
export function mapError(status, body, headers) {
  const err = (body && body.error) || {};
  const code = typeof err.code === 'string' ? err.code : '';
  const msg = err.detail || err.message || (body && body.message) || '';
  const where = fieldsFromMeta(err);

  if (/TOKEN|SUBSCRIPTION/i.test(code)) {
    return { kind: 'auth', statusCode: status, code, message: msg || 'Brave subscription token is invalid' };
  }
  if (/OPTION_NOT_IN_PLAN|PLAN/i.test(code)) {
    return {
      kind: 'plan_gate', statusCode: status, code,
      message: `${msg || 'this option is not included in your Brave plan'} (upgrade at https://api-dashboard.search.brave.com — the request itself was well-formed)`,
    };
  }
  if (/VALIDATION/i.test(code)) {
    return {
      kind: 'config_4xx', statusCode: status, code,
      message: `${msg || 'invalid request parameter'}${where ? ` [${where}]` : ''}`,
    };
  }
  if (status === 429) {
    return { kind: 'rate_limit_429', statusCode: status, code, message: msg || 'Brave rate limit', retryAfterMs: resetDelayMs(headers) };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', statusCode: status, code, message: msg || `Brave rejected the key (HTTP ${status})` };
  }
  if (status === 402) {
    return { kind: 'auth', statusCode: status, code, message: msg || 'Brave: billing required / out of credit' };
  }
  if (status >= 500) {
    return { kind: 'server_5xx', statusCode: status, code, message: msg || 'Brave server error' };
  }
  if (status === 422 || status === 400) {
    // A 4xx we could not attribute. Treat it as the caller's problem rather
    // than destroying keys on an unknown code.
    return { kind: 'config_4xx', statusCode: status, code, message: msg || `HTTP ${status}` };
  }
  return { kind: 'caller_4xx', statusCode: status, code, message: msg || `unexpected HTTP ${status}` };
}

function fieldsFromMeta(err) {
  const errs = err && err.meta && Array.isArray(err.meta.errors) ? err.meta.errors : [];
  const names = errs
    .map(e => (Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : null))
    .filter(Boolean);
  return names.length ? names.join(', ') : '';
}

function asError(status, body, headers) {
  const m = mapError(status, body, headers);
  return Object.assign(
    new Error(`brave ${m.kind}${m.code ? ` (${m.code})` : ''} (HTTP ${status}): ${m.message}`),
    m,
    { body },
  );
}

export function resolveMode(args) {
  if (MODES.includes(args.mode)) return args.mode;
  // Legacy --depth, kept so old scripts keep working.
  if (args.depth === 'advanced') return 'slow';
  if (args.depth === 'fast' || args.depth === 'ultra-fast') return 'fast';
  if (args.depth === 'basic') return 'normal';
  return 'normal';
}

/**
 * --time / --start-date / --end-date → Brave `freshness`.
 * An explicit date range beats a relative window.
 */
export function resolveFreshness(args) {
  if (typeof args.freshness === 'string' && args.freshness.trim()) return args.freshness.trim();
  const start = isoDay(args.startDate);
  const end = isoDay(args.endDate);
  if (start || end) {
    const from = start || '1970-01-01';
    const to = end || isoDay(new Date().toISOString());
    return `${from}to${to}`;
  }
  if (typeof args.time === 'string') return TIME_TO_FRESHNESS[args.time] || undefined;
  return undefined;
}

function isoDay(v) {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/**
 * Fold --domains / --exclude into the query string as site: operators.
 *
 * Includes MUST be OR-grouped: `site:a.com site:b.com` is ANDed by Brave and a
 * page cannot live on two domains, so the naive form returns nothing.
 * The wire query is kept separate from the user's query — the envelope must
 * still echo what the caller actually asked.
 */
export function buildWireQuery(query, args) {
  const include = splitList(args.domains) || [];
  const exclude = splitList(args.excludeDomains) || [];
  let q = String(query).trim();
  if (include.length) {
    q += include.length === 1
      ? ` site:${include[0]}`
      : ` (${include.map(d => `site:${d}`).join(' OR ')})`;
  }
  for (const d of exclude) q += ` -site:${d}`;

  let truncated = false;
  if (q.length > MAX_QUERY_CHARS) { q = q.slice(0, MAX_QUERY_CHARS).trim(); truncated = true; }
  const words = q.split(/\s+/);
  if (words.length > MAX_QUERY_WORDS) { q = words.slice(0, MAX_QUERY_WORDS).join(' '); truncated = true; }
  return { q, truncated };
}

async function search(args, ctx) {
  const query = args.query;
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw Object.assign(new Error('brave search requires a non-empty query'), {
      kind: 'caller_4xx', statusCode: 400,
    });
  }

  const mode = resolveMode(args);
  // An explicit --max is authoritative; otherwise the mode picks the breadth.
  // intOr is what stops `--max abc` from reaching the wire as count=NaN, which
  // Brave answers with a 422 that used to be misread as a dead key.
  const count = args.max === undefined || args.max === null || args.max === ''
    ? (MODE_TO_COUNT[mode] || 10)
    : intOr(args.max, { min: 1, max: MAX_COUNT, fallback: MODE_TO_COUNT[mode] || 10 });
  const offset = args.offset === undefined || args.offset === null || args.offset === ''
    ? undefined
    : intOr(args.offset, { min: 0, max: MAX_OFFSET, fallback: undefined });

  const { q, truncated } = buildWireQuery(query, args);
  if (truncated) {
    progress.warn(`brave: query truncated to Brave's ${MAX_QUERY_CHARS}-char / ${MAX_QUERY_WORDS}-word limit`);
  }
  if (args.topic === 'finance') {
    progress.warn(`brave: --topic finance has no Brave equivalent and was ignored (news is supported)`);
  }

  const params = compactObject({
    q,
    count,
    offset,
    country: args.country,
    search_lang: args.searchLang,
    ui_lang: args.uiLang,
    safesearch: args.safesearch,
    freshness: resolveFreshness(args),
    // Highlight markup off at the source: <strong> around every query term was
    // being piped verbatim into markdown output and into LLM prompts.
    text_decorations: 0,
    // Up to 5 more excerpts per result. Silently omitted on plans without it.
    extra_snippets: args.extraSnippets === false ? undefined : 'true',
    result_filter: args.resultFilter || (args.topic === 'news' ? 'news' : undefined),
    goggles: args.goggles,
    spellcheck: args.spellcheck === false ? 0 : undefined,
  });

  const { status, ok, data, headers, latency_ms } = await doFetch('/web/search', params, ctx);
  if (!ok) throw asError(status, data, headers);

  const results = ((data.web && data.web.results) || []).map(it => {
    // description is one snippet; extra_snippets are alternative excerpts of
    // the same page. Joining them is the whole quality gain available here.
    const parts = [stripHtml(it.description || '')];
    if (Array.isArray(it.extra_snippets)) {
      for (const s of it.extra_snippets) {
        const clean = stripHtml(s);
        if (clean && !parts.includes(clean)) parts.push(clean);
      }
    }
    return {
      url: it.url,
      title: stripHtml(it.title || '') || it.url,
      content: parts.filter(Boolean).join('\n'),
      score: undefined,          // Brave exposes no numeric relevance score
      raw_content: undefined,    // /web/search never returns page content
      published_date: it.page_age || undefined,  // ISO-8601 only
      age_text: it.age || undefined,             // display string, never sent to an LLM
      snippet_count: Array.isArray(it.extra_snippets) ? it.extra_snippets.length + 1 : 1,
    };
  });

  const q_meta = data.query || {};
  return {
    provider: 'brave',
    operation: 'search',
    raw: data,
    usage: { credits: 1 },
    latency_ms,
    data: {
      query,                     // the caller's query, not the wire query
      wire_query: q !== query ? q : undefined,
      answer: undefined,         // /web/search has no synthesized answer
      results,
      // ABSENT means exhausted, so read it as false rather than defaulting true.
      more_results_available: q_meta.more_results_available === true,
      operators_applied: q_meta.search_operators || undefined,
      altered_query: q_meta.altered || undefined,
      extra_snippets_available: results.some(r => r.snippet_count > 1),
    },
  };
}

/**
 * Validate a key for FREE.
 *
 * A request with no `q` fails validation before it is billed — Brave documents
 * that failed requests do not count against quota, and an A/B of 108 failing
 * requests moved the monthly counter by zero. So both a good and a bad key
 * answer 422 here, and they are told apart purely by `error.code`:
 *
 *   VALIDATION                 → the key was accepted, only `q` was missing → GOOD
 *   SUBSCRIPTION_TOKEN_INVALID → the key was rejected                        → BAD
 *
 * Costs no credits and no quota, which is what makes it affordable to run this
 * gate on every single invocation.
 */
async function validate(key, { timeout = 20_000, version, pace } = {}) {
  const ctx = { key, timeout, version };
  const t0 = Date.now();
  try {
    // PACED, even though it is never billed: Brave counts requests on ARRIVAL,
    // so a "free" probe still consumes the 1-second window and will 429 the
    // real search that follows it. Verified the hard way.
    const { status, data, headers } = await doFetch('/web/search', { count: 1 }, ctx, { pace: pace !== false });
    const code = (data && data.error && data.error.code) || '';
    if (/VALIDATION/i.test(code)) {
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 0, free: true };
    }
    if (/TOKEN|SUBSCRIPTION/i.test(code)) {
      return {
        valid: false, provider: 'brave', latency_ms: Date.now() - t0,
        kind: 'auth', statusCode: status, error: (data.error && data.error.detail) || 'invalid subscription token',
      };
    }
    if (status === 429) {
      // Rate-limited, not invalid: the key was accepted well enough to be counted.
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 0, free: true, throttled: true };
    }
    if (status >= 200 && status < 300) {
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 1 };
    }
    const m = mapError(status, data, headers);
    // A plan gate proves the key itself is fine.
    if (m.kind === 'plan_gate') {
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 0, free: true };
    }
    return { valid: false, provider: 'brave', latency_ms: Date.now() - t0, kind: m.kind, statusCode: status, error: m.message };
  } catch (e) {
    return {
      valid: false, provider: 'brave', latency_ms: Date.now() - t0,
      kind: e.kind || 'network', statusCode: e.statusCode, error: e.message || String(e),
    };
  }
}
