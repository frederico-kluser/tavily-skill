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
//
// THREE INVARIANTS THIS FILE EXISTS TO HOLD (each one was a live defect):
//
//   1. A TRANSIENT limit must never be turned into a PERMANENT loss. Burning a
//      key (kind 'auth') is irreversible — state.markBurned has no expiry — so
//      it happens only on unambiguous proof that the key itself is rejected.
//      Anything that refills (per-second rate, monthly quota, billing) is
//      classified as rate_limit_429 and merely sidelines the key.
//   2. A search operator is ATOMIC. `-site:c.com` cut down to `-site:c`
//      excludes a DIFFERENT domain and still looks right — a silently wrong
//      answer, which is worse than an error. Truncation therefore happens on
//      the caller's words, never on an operator, and operators that do not fit
//      are dropped whole and announced.
//   3. Every failure path leaves this adapter with a `kind` on the error.
//      dispatch.mjs keys its whole retry/burn/cooldown policy off that field;
//      a bare TypeError is filed as caller_4xx and skips the retry budget.

import { compactObject, intOr, splitList } from '../flags.mjs';
import { stripHtml } from '../html.mjs';
import { acquireSlot, learnFromHeaders, learnFromBody, resetDelayMs } from '../ratelimit.mjs';
import { progress } from '../progress.mjs';
// Default for the X-Client-Name version when a caller does not pass one.
// Read from package.json (src/lib/version.mjs), never retyped: this header is
// what Brave sees on every single request we make.
import { VERSION } from '../version.mjs';

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
// The only two shapes Brave accepts for `freshness`.
const FRESHNESS_TOKENS = new Set(['pd', 'pw', 'pm', 'py']);
const FRESHNESS_RANGE_RE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/i;

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
    'X-Client-Name': `surf-agent-skill/${version || VERSION}`,
  };
}

async function doFetch(path, params, ctx, { pace = true } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue; // never serialise NaN
    if (typeof v === 'object' || typeof v === 'function' || typeof v === 'symbol') {
      // String({}) is "[object Object]", which Brave answers with a 422 — a
      // wasted request against a 1 req/s window. Drop it loudly instead.
      progress.warn(`brave: ignored ${k} — expected a scalar, got ${Array.isArray(v) ? 'a list' : typeof v}`);
      continue;
    }
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

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// Codes Brave is documented to send, matched EXACTLY (not by substring).
const EXACT_CODES = new Map([
  ['SUBSCRIPTION_TOKEN_INVALID', 'auth'],
  ['VALIDATION', 'config_4xx'],
  ['OPTION_NOT_IN_PLAN', 'plan_gate'],
  ['RATE_LIMITED', 'rate_limit_429'],
  // Observed on quota exhaustion. It contains the word SUBSCRIPTION, which is
  // exactly why substring matching on that word is not allowed to decide.
  ['SUBSCRIPTION_QUOTA_EXCEEDED', 'rate_limit_429'],
  ['QUOTA_EXCEEDED', 'rate_limit_429'],
]);

// The ONLY statuses on which surf is willing to destroy a key. Brave answers an
// invalid token with 422; 401/403 are the generic proxy spellings of the same
// thing. Every other status leaves the key alone, because an un-burned key that
// keeps failing is recoverable and a burned key is not.
const AUTH_STATUSES = new Set([401, 403, 422]);

// Ordered on purpose — see classify(). Transient beats everything.
const TRANSIENT_CODE = /QUOTA|RATE_?LIMIT|LIMIT_?EXCEED|EXCEEDED|THROTTL|TOO_?MANY|OVER_?CAPACITY|BUSY|UNAVAILABLE/i;
const PLAN_CODE = /PLAN|UPGRADE|NOT_INCLUDED|ENTITLE/i;
const CONFIG_CODE = /VALIDATION|INVALID_(PARAM|QUERY|ARG|VALUE|REQUEST)|MISSING|BAD_?REQUEST|UNSUPPORTED|MALFORMED/i;
const AUTH_CODE = /TOKEN|SUBSCRIPTION|API_?KEY|UNAUTHOR|FORBIDDEN|CREDENTIAL/i;

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
 *   429 RATE_LIMITED                → a budget that refills    → do NOT burn
 *
 * Note OPTION_NOT_IN_PLAN also carries meta.component === 'authentication',
 * so branching on that field instead would burn a perfectly good key.
 *
 * THE ORDER BELOW IS THE FIX, and it is deliberate:
 *
 *   1. exact code table            — the four documented codes, no guessing
 *   2. HTTP 429                    — transient by definition, whatever the body
 *   3. transient patterns          — QUOTA/LIMIT/EXCEEDED …
 *   4. plan patterns               — PLAN/UPGRADE …
 *   5. config patterns             — VALIDATION/INVALID_PARAM …
 *   6. auth patterns, AND ONLY on a status where auth is plausible
 *   7. status-only fallbacks, defaulting to "the caller's problem"
 *
 * The auth test is LAST and status-gated because it is the only irreversible
 * verdict. Before this order, `SUBSCRIPTION_QUOTA_EXCEEDED` on a 429 — "you
 * used this month's requests, come back next month" — matched SUBSCRIPTION and
 * was filed as a dead key, so a limit that clears on the 1st destroyed the key
 * on the 30th. mapError also never throws: it is the function whose entire job
 * is turning a hostile body into a classification, so a hostile body must not
 * be able to make it produce a stack trace instead.
 */
export function mapError(status, body, headers) {
  try {
    return classify(status, body, headers);
  } catch (e) {
    // Even the classifier failing must still produce a kind — never a throw.
    return {
      kind: inRange(status, 500, 599) ? 'server_5xx' : 'config_4xx',
      statusCode: status,
      code: '',
      message: `Brave error body could not be classified (${e && e.message}) — the key was left alone`,
    };
  }
}

function classify(status, body, headers) {
  const err = (body && typeof body === 'object' && body.error && typeof body.error === 'object')
    ? body.error : {};
  const code = typeof err.code === 'string' ? err.code.trim() : '';
  const upper = code.toUpperCase();
  const msg = asText(err.detail) || asText(err.message) || asText(body && body.message) || '';
  const where = fieldsFromMeta(err);
  const s = Number.isFinite(Number(status)) ? Number(status) : 0;

  const base = { statusCode: status, code };
  const rate = (extra) => ({
    ...base, kind: 'rate_limit_429',
    message: `${msg || 'Brave rate limit'}${extra ? ` — ${extra}` : ''}`,
    retryAfterMs: safeResetDelayMs(headers),
  });
  const plan = () => ({
    ...base, kind: 'plan_gate',
    message: `${msg || 'this option is not included in your Brave plan'} (upgrade at https://api-dashboard.search.brave.com — the request itself was well-formed)`,
  });
  const config = () => ({
    ...base, kind: 'config_4xx',
    message: `${msg || `invalid request parameter (HTTP ${status})`}${where ? ` [${where}]` : ''}`,
  });
  const auth = () => ({
    ...base, kind: 'auth',
    message: msg || `Brave rejected the key (HTTP ${status})`,
  });

  // 1. The documented codes, matched exactly.
  const exact = EXACT_CODES.get(upper);
  if (exact === 'rate_limit_429') return rate(quotaHint(upper));
  if (exact === 'plan_gate') return plan();
  if (exact === 'config_4xx') return config();
  if (exact === 'auth' && AUTH_STATUSES.has(s)) return auth();

  // 2. A 429 is a budget that refills. It is NEVER proof of a dead key.
  if (s === 429) return rate(quotaHint(upper));

  // 3-5. Transient, then plan, then caller — all before anything can be auth.
  if (TRANSIENT_CODE.test(upper)) return rate(quotaHint(upper));
  if (PLAN_CODE.test(upper)) return plan();
  if (CONFIG_CODE.test(upper)) return config();

  // 6. Auth last, and only where a rejected token is actually plausible.
  if (AUTH_CODE.test(upper) && AUTH_STATUSES.has(s)) return auth();

  // 7. Status-only fallbacks.
  if (s === 401 || s === 403) return auth();
  if (s === 402) {
    // Billing / out of credit. Recoverable by the account owner (and by the
    // next billing cycle), so the key is sidelined, never destroyed.
    return rate('Brave reports billing required / out of credit — the key is sidelined, not burned');
  }
  if (inRange(s, 500, 599)) {
    return { ...base, kind: 'server_5xx', message: msg || 'Brave server error' };
  }
  if (s === 422 || s === 400) {
    // A 4xx we could not attribute. Treat it as the caller's problem rather
    // than destroying keys on an unknown code.
    return { ...base, kind: 'config_4xx', message: msg || `HTTP ${status}` };
  }
  return { ...base, kind: 'caller_4xx', message: msg || `unexpected HTTP ${status}` };
}

function quotaHint(upper) {
  return /QUOTA/.test(upper)
    ? 'this is the plan QUOTA, not a dead key: the key is sidelined until the quota resets'
    : '';
}

function inRange(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi;
}

function safeResetDelayMs(headers) {
  try { return resetDelayMs(headers); } catch { return null; }
}

/** Brave's `detail` is a string in practice and an object in a bad month. */
function asText(v, cap = 300) {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    if (!s) return '';
    return s.length > cap ? `${s.slice(0, cap)}…` : s;
  } catch { return ''; }
}

function fieldsFromMeta(err) {
  try {
    const errs = err && err.meta && Array.isArray(err.meta.errors) ? err.meta.errors : [];
    const names = errs
      .map(e => (e && typeof e === 'object' && Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : null))
      .filter(n => typeof n === 'string' || typeof n === 'number')
      .map(String)
      .filter(Boolean);
    return names.length ? names.join(', ') : '';
  } catch { return ''; }
}

function asError(status, body, headers) {
  const m = mapError(status, body, headers);
  return Object.assign(
    new Error(`brave ${m.kind}${m.code ? ` (${m.code})` : ''} (HTTP ${status}): ${m.message}`),
    m,
    { body },
  );
}

/** Every error this adapter raises carries a kind; dispatch.mjs depends on it. */
function braveError(message, kind, extra = {}) {
  return Object.assign(new Error(message), { kind, ...extra });
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
 *
 * Everything here is CHECKED before it reaches the wire. A freshness Brave
 * rejects costs a request against a 1 req/s window, a 422 in the audit log and
 * a retry budget — and `--freshness` is the one search flag with no CLI-side
 * enum check, so this is its only line of defence. An invalid value is dropped
 * with a warning rather than thrown, because dropping degrades to "unfiltered"
 * while throwing from a pure helper would take the whole run down.
 */
export function resolveFreshness(args) {
  if (typeof args.freshness === 'string' && args.freshness.trim()) {
    const raw = args.freshness.trim();
    const token = raw.toLowerCase();
    if (FRESHNESS_TOKENS.has(token)) return token;
    const m = raw.match(FRESHNESS_RANGE_RE);
    if (m && isoDay(m[1]) && isoDay(m[2])) {
      const from = isoDay(m[1]);
      const to = isoDay(m[2]);
      return from <= to ? `${from}to${to}` : `${to}to${from}`;
    }
    progress.warn(
      `brave: --freshness "${raw}" is not one of pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD — dropped (the search ran unfiltered)`,
    );
    return undefined;
  }
  const start = isoDay(args.startDate, '--start-date');
  const end = isoDay(args.endDate, '--end-date');
  if (start || end) {
    const from = start || '1970-01-01';
    const to = end || isoDay(new Date().toISOString());
    if (from > to) {
      // Brave reads the range left to right: an inverted one matches nothing
      // and returns an empty, entirely plausible-looking result set.
      progress.warn(`brave: --start-date ${from} is after --end-date ${to}; the range was inverted for you`);
      return `${to}to${from}`;
    }
    return `${from}to${to}`;
  }
  if (typeof args.time === 'string') return TIME_TO_FRESHNESS[args.time] || undefined;
  return undefined;
}

/**
 * A REAL calendar day, not the shape of one. `2026-13-45` matches the shape and
 * is not a date; Brave answers it with a 422 that costs a request and a retry.
 */
function isoDay(v, label) {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const raw = v.trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    if (label) progress.warn(`brave: ${label} "${raw}" is not YYYY-MM-DD — dropped (the search ran unfiltered on that bound)`);
    return undefined;
  }
  const [, y, mo, d] = m;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  const valid =
    year >= 1000 && year <= 9999 &&
    month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth(year, month);
  if (!valid) {
    if (label) progress.warn(`brave: ${label} "${raw}" is not a real calendar date — dropped (the search ran unfiltered on that bound)`);
    return undefined;
  }
  return `${y}-${mo}-${d}`;
}

function daysInMonth(year, month) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// ---------------------------------------------------------------------------
// Query assembly
// ---------------------------------------------------------------------------

// A positive `site:` the CALLER typed. `-site:` is deliberately not matched:
// exclusions AND together correctly, it is only the inclusions that must be
// OR-grouped.
const INLINE_SITE_RE = /(^|\s)site:([^\s()]+)/gi;

/**
 * Fold --domains / --exclude into the query string as site: operators.
 *
 * Includes MUST be OR-grouped: `site:a.com site:b.com` is ANDed by Brave and a
 * page cannot live on two domains, so the naive form returns nothing.
 * The wire query is kept separate from the user's query — the envelope must
 * still echo what the caller actually asked.
 *
 * TRUNCATION RUNS ON THE CALLER'S WORDS, NEVER ON AN OPERATOR. Cutting the
 * assembled string (as this function used to) turns `-site:c.com` into
 * `-site:c` — a valid operator excluding the WRONG domain, returning results
 * that look right — and leaves `(site:a.com OR site:b` unbalanced. Operators
 * are therefore appended after the query has been made to fit, and one that
 * still does not fit is dropped whole and reported in `notes`.
 */
export function buildWireQuery(query, args) {
  args = args || {};
  const notes = [];
  let base = (typeof query === 'string' ? query : (query === null || query === undefined ? '' : String(query))).trim();

  const include = cleanDomains(args.domains, '--domains', notes);
  const exclude = cleanDomains(args.excludeDomains, '--exclude-domains', notes);

  // The caller already wrote `site:` AND passed --domains. Brave ANDs site:
  // operators, so appending a second one guarantees zero results. Fold the two
  // into the same OR group instead — the only reading that can match anything.
  if (include.length) {
    const inline = [];
    base = base
      .replace(INLINE_SITE_RE, (whole, pre, dom) => {
        const d = normalizeDomain(dom);
        if (!d) return whole;
        inline.push(d);
        return pre;
      })
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (inline.length) {
      notes.push(
        `the query already contained ${inline.map(d => `site:${d}`).join(', ')} and --domains adds more; ` +
        `Brave ANDs site: operators (which matches nothing), so they were merged into one OR group`,
      );
      for (const d of inline.reverse()) if (!include.includes(d)) include.unshift(d);
    }
  }

  const ops = [];
  if (include.length === 1) ops.push(`site:${include[0]}`);
  else if (include.length > 1) ops.push(`(${include.map(d => `site:${d}`).join(' OR ')})`);
  for (const d of exclude) ops.push(`-site:${d}`);

  let truncated = false;

  // An operator is atomic: emitted whole, or dropped whole and said out loud.
  while (ops.length && (opChars(ops) + 2 > MAX_QUERY_CHARS || opWords(ops) + 1 > MAX_QUERY_WORDS)) {
    const dropped = ops.pop();
    truncated = true;
    notes.push(`operator ${dropped} does not fit Brave's ${MAX_QUERY_CHARS}-char / ${MAX_QUERY_WORDS}-word query and was dropped whole (cutting it would have filtered the wrong domain)`);
  }

  const suffix = ops.join(' ');
  const charRoom = MAX_QUERY_CHARS - (suffix ? suffix.length + 1 : 0);
  const wordRoom = MAX_QUERY_WORDS - (suffix ? countWords(suffix) : 0);
  const fitted = fitBase(base, charRoom, wordRoom);
  if (fitted.truncated) {
    truncated = true;
    notes.push(`query truncated to Brave's ${MAX_QUERY_CHARS}-char / ${MAX_QUERY_WORDS}-word limit`);
  }

  const q = [fitted.text, suffix].filter(Boolean).join(' ');
  return { q, truncated, notes };
}

function opChars(ops) { return ops.join(' ').length; }
function opWords(ops) { return countWords(ops.join(' ')); }
function countWords(s) { return s ? s.split(/\s+/).filter(Boolean).length : 0; }

function fitBase(base, charRoom, wordRoom) {
  if (!base) return { text: '', truncated: false };
  if (charRoom <= 0 || wordRoom <= 0) return { text: '', truncated: true };
  let truncated = false;

  let words = base.split(/\s+/).filter(Boolean);
  if (words.length > wordRoom) { words = words.slice(0, wordRoom); truncated = true; }
  let text = words.join(' ');

  if (text.length > charRoom) {
    const cut = text.slice(0, charRoom);
    const sp = cut.lastIndexOf(' ');
    text = (sp > 0 ? cut.slice(0, sp) : cut).replace(/\s+$/, '');
    truncated = true;
  }
  if (truncated) text = repair(text, charRoom);
  return { text, truncated };
}

/**
 * Make a cut query syntactically whole again.
 *
 * A dangling `(` or `"` is a syntax error Brave answers with junk. Closing a cut
 * phrase is the safe repair: `"a b c"` shortened to `"a b"` matches a SUPERSET
 * of what the caller asked for, so nothing they wanted is silently excluded.
 */
function repair(text, maxChars) {
  let out = dropUnmatchedParens(text);
  if ((out.split('"').length - 1) % 2 === 1) {
    if (out.length < maxChars) out += '"';
    else out = `${out.slice(0, Math.max(0, maxChars - 1)).replace(/\s+$/, '')}"`;
  }
  return out;
}

function dropUnmatchedParens(s) {
  const drop = new Set();
  const open = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') open.push(i);
    else if (s[i] === ')') { if (open.length) open.pop(); else drop.add(i); }
  }
  for (const i of open) drop.add(i);
  if (!drop.size) return s;
  return [...s].filter((_, i) => !drop.has(i)).join('').replace(/\s{2,}/g, ' ').trim();
}

function cleanDomains(raw, label, notes) {
  const list = splitList(raw) || [];
  const out = [];
  for (const item of list) {
    const d = normalizeDomain(item);
    if (!d) {
      notes.push(`${label} entry ${JSON.stringify(String(item))} is not a domain and was ignored (it would have broken the site: operator)`);
      continue;
    }
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * A domain, or null. Scheme, path, port and a trailing dot are stripped because
 * they name the SAME host; anything that would break the operator itself
 * (whitespace, parens, quotes) is refused rather than silently reshaped.
 */
function normalizeDomain(raw) {
  let d = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!d || d.length > 253) return null;
  if (/[\s()"'|&,<>\\]/.test(d)) return null;
  if (!d.includes('.')) return null;
  if (d.startsWith('.') || d.startsWith('-')) return null;
  return d;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const FALSEY_STRING_RE = /^(false|0|no|off)$/i;

async function search(args, ctx) {
  const query = args.query;
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw braveError('brave search requires a non-empty query', 'caller_4xx', { statusCode: 400 });
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

  const { q, truncated, notes } = buildWireQuery(query, args);
  for (const n of notes || []) progress.warn(`brave: ${n}`);
  if (truncated && !(notes || []).length) {
    progress.warn(`brave: query truncated to Brave's ${MAX_QUERY_CHARS}-char / ${MAX_QUERY_WORDS}-word limit`);
  }
  if (args.topic === 'finance') {
    progress.warn(`brave: --topic finance has no Brave equivalent and was ignored (news is supported)`);
  }

  // `--extra-snippets false` arrives from a flag parser as the STRING "false".
  const extraOff = args.extraSnippets === false
    || (typeof args.extraSnippets === 'string' && FALSEY_STRING_RE.test(args.extraSnippets.trim()));

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
    extra_snippets: extraOff ? undefined : 'true',
    result_filter: args.resultFilter || (args.topic === 'news' ? 'news' : undefined),
    goggles: args.goggles,
    spellcheck: args.spellcheck === false ? 0 : undefined,
  });

  const { status, ok, data, headers, latency_ms } = await doFetch('/web/search', params, ctx);
  if (!ok) throw asError(status, data, headers);

  // A 200 whose body is the JSON literal `null`, a bare number or an array is a
  // broken upstream response (a proxy, a truncated gzip stream), not an empty
  // result set. It must fail with a KIND — dispatch.mjs keys its retry budget
  // off that field and files a bare TypeError as the caller's fault.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw braveError(
      `brave server_5xx (HTTP ${status}): Brave returned a body that is not a JSON object (${data === null ? 'null' : typeof data})`,
      'server_5xx',
      { statusCode: status },
    );
  }

  const web = data.web && typeof data.web === 'object' ? data.web : {};
  // Guarded against not-an-array, not merely against falsiness: an object or a
  // string here used to reach .map and throw an un-kinded TypeError.
  const rawResults = Array.isArray(web.results) ? web.results : [];

  const results = [];
  let skipped = 0;
  for (const it of rawResults) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) { skipped++; continue; }
    // Every downstream contract of this tool is a citation. A result with no
    // URL cannot be cited, so it is dropped rather than shipped as a claim
    // nobody can check.
    const url = typeof it.url === 'string' && it.url.trim() ? it.url.trim() : null;
    if (!url) { skipped++; continue; }

    // description is one snippet; extra_snippets are alternative excerpts of
    // the same page. Joining them is the whole quality gain available here.
    const parts = [stripHtml(typeof it.description === 'string' ? it.description : '')];
    if (Array.isArray(it.extra_snippets)) {
      for (const s of it.extra_snippets) {
        const clean = stripHtml(typeof s === 'string' ? s : '');
        if (clean && !parts.includes(clean)) parts.push(clean);
      }
    }
    results.push({
      url,
      title: stripHtml(typeof it.title === 'string' ? it.title : '') || url,
      content: parts.filter(Boolean).join('\n'),
      score: undefined,          // Brave exposes no numeric relevance score
      raw_content: undefined,    // /web/search never returns page content
      // ISO-8601 ONLY. `age` is a display string and Brave is not consistent
      // about which one lands in page_age; anything else would become a date an
      // LLM is told to trust.
      published_date: typeof it.page_age === 'string' && ISO_DATE_RE.test(it.page_age.trim())
        ? it.page_age.trim()
        : undefined,
      age_text: typeof it.age === 'string' ? it.age : undefined, // display string, never sent to an LLM
      snippet_count: Array.isArray(it.extra_snippets) ? it.extra_snippets.length + 1 : 1,
    });
  }
  if (skipped) {
    progress.warn(`brave: dropped ${skipped} result(s) with no usable url (a citation nobody can follow is worse than one fewer result)`);
  }

  const q_meta = data.query && typeof data.query === 'object' ? data.query : {};
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
 *
 * The verdict is delegated to mapError rather than re-implemented here: this
 * function's result is CACHED into keys.json for 7 days, so a second, looser
 * copy of the classification rules is a second way to condemn a good key.
 */
async function validate(key, { timeout = 20_000, version, pace } = {}) {
  const ctx = { key, timeout, version };
  const t0 = Date.now();
  try {
    // PACED, even though it is never billed: Brave counts requests on ARRIVAL,
    // so a "free" probe still consumes the 1-second window and will 429 the
    // real search that follows it. Verified the hard way.
    const { status, data, headers } = await doFetch('/web/search', { count: 1 }, ctx, { pace: pace !== false });
    const code = (data && typeof data === 'object' && data.error && typeof data.error.code === 'string')
      ? data.error.code : '';
    if (/VALIDATION/i.test(code)) {
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 0, free: true };
    }
    if (status >= 200 && status < 300) {
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 1 };
    }
    const m = mapError(status, data, headers);
    // Rate-limited or out of quota: not invalid. The key was accepted well
    // enough to be counted, and a monthly quota clears on the 1st.
    if (m.kind === 'rate_limit_429') {
      return { valid: true, provider: 'brave', latency_ms: Date.now() - t0, credits: 0, free: true, throttled: true };
    }
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
