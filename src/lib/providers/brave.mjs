// Brave Search adapter — talks to https://api.search.brave.com/res/v1 with
// X-Subscription-Token header.
//
// Capability:
//   - search:    GET /web/search  (only operation supported)
//   - extract / crawl / map / research-*: NOT supported (Brave has no equivalents)
//
// Auth: header `X-Subscription-Token: <key>` (NOT Bearer; NOT ?apikey=).
// Rate limits: 50 RPS for /web/search (2 RPS for /summarizer/* — not used here).
// Pricing as of 2026-05: $5/mo credit + metered (~$0.003/query). Free tier
// (2,000 queries/mo) was discontinued in Feb 2026.

import { compactObject, clamp } from '../flags.mjs';

const BASE = process.env.SURF_BRAVE_API_BASE || 'https://api.search.brave.com/res/v1';
const DEFAULT_TIMEOUT = Number(process.env.SURF_TIMEOUT_MS) || 45000;

// Mode → count mapping. Brave doesn't have native fast/slow tiers, so we use
// `count` (max 20) as the differentiator. fast = fewer results, slow = more.
const MODE_TO_COUNT = { fast: 5, normal: 10, slow: 20 };

export const braveProvider = {
  name: 'brave',
  supports: {
    search: true,
    extract: false,
    crawl: false,
    map: false,
    'research-start': false,
    'research-poll': false,
    usage: false,
  },
  search,
  extract: notSupported('extract'),
  crawl: notSupported('crawl'),
  map: notSupported('map'),
  'research-start': notSupported('research-start'),
  'research-poll': notSupported('research-poll'),
  usage: notSupported('usage'),
  mapError,
};

function notSupported(op) {
  return async () => {
    throw Object.assign(new Error(`brave does not support '${op}'`), {
      kind: 'not_supported', statusCode: 0,
    });
  };
}

function buildHeaders(key, version) {
  return {
    'X-Subscription-Token': key,
    'Accept': 'application/json',
    'X-Client-Name': `surf-agent-skill/${version || '2.1.0'}`,
  };
}

async function doFetch(path, params, ctx) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
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
    return { status: res.status, ok: res.ok, data, latency_ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError' || /timeout/i.test(e.message)) {
      throw Object.assign(new Error(`Brave request exceeded ${timeout}ms`), { kind: 'network' });
    }
    throw Object.assign(new Error(`Brave network error: ${e.message}`), { kind: 'network' });
  }
}

function mapError(status, body) {
  const msg = (body && (body.error?.message || body.message)) || '';
  if (status === 401) return { kind: 'auth', statusCode: status, message: 'invalid Brave key' };
  if (status === 402) return { kind: 'auth', statusCode: status, message: msg || 'Brave: insufficient credits / billing required' };
  if (status === 403) return { kind: 'auth', statusCode: status, message: msg || 'forbidden (plan/billing)' };
  // Brave returns 422 for several reasons: malformed token (length/charset
  // wrong, fails BEFORE auth check), OR bad query params. We classify 422 as
  // `auth` so the key gets burned and dispatch rotates. The trade-off: a
  // genuinely-bad query param will fail across ALL keys and surface as
  // AllProvidersExhausted, still actionable. A malformed token is the
  // dominant cause in practice (real tokens hit 401 instead).
  if (status === 422) return { kind: 'auth', statusCode: status, message: msg || 'Brave: malformed token or invalid params (key rotation will retry; if all keys fail, you likely have a bad query)' };
  if (status === 429) return { kind: 'rate_limit_429', statusCode: status, message: msg || 'Brave rate limit (50 RPS search)' };
  if (status >= 500)  return { kind: 'server_5xx', statusCode: status, message: msg || 'Brave server error' };
  if (status >= 400)  return { kind: 'caller_4xx', statusCode: status, message: msg || `HTTP ${status}` };
  return { kind: 'caller_4xx', statusCode: status, message: msg || `unexpected HTTP ${status}` };
}

function asError(status, body) {
  const m = mapError(status, body);
  return Object.assign(new Error(`brave ${m.kind} (HTTP ${status}): ${m.message}`), m, { body });
}

function resolveMode(args) {
  if (args.mode === 'fast' || args.mode === 'normal' || args.mode === 'slow') return args.mode;
  // Backward compat with --depth (Tavily-ism):
  if (args.depth === 'advanced') return 'slow';
  if (args.depth === 'fast' || args.depth === 'ultra-fast') return 'fast';
  return 'normal';
}

async function search(args, ctx) {
  const query = args.query;
  if (!query) {
    throw Object.assign(new Error('brave search requires a query'), {
      kind: 'caller_4xx', statusCode: 400,
    });
  }

  const mode = resolveMode(args);
  // If user explicitly passed --max, honor it (capped at Brave's max=20);
  // otherwise derive from mode.
  const count = args.max
    ? clamp(Number(args.max), 1, 20)
    : (MODE_TO_COUNT[mode] || 10);

  const params = compactObject({
    q: query,
    count,
    offset: args.offset != null ? clamp(Number(args.offset), 0, 9) : undefined,
    country: args.country,
    search_lang: args.searchLang,
    ui_lang: args.uiLang,
    safesearch: args.safesearch,         // 'off' | 'moderate' | 'strict'
    goggles_id: args.goggle,             // Brave-only ranking filter
    result_filter: args.resultFilter,    // 'web,news,faq,...'
    spellcheck: args.spellcheck === false ? 0 : undefined,
  });

  const { status, ok, data, latency_ms } = await doFetch('/web/search', params, ctx);
  if (!ok) throw asError(status, data);

  return {
    provider: 'brave',
    operation: 'search',
    raw: data,
    usage: { credits: 1 }, // ~$0.003/query metered; we report 1 credit as proxy
    latency_ms,
    data: {
      query,
      // /web/search response may include a `summarizer` block when the user's
      // plan + query qualify. We surface the summary text as `answer` for
      // schema parity with Tavily.
      answer: data.summarizer && (data.summarizer.summary || data.summarizer.title),
      results: (data.web && data.web.results || []).map(it => ({
        url: it.url,
        title: it.title,
        // Brave returns rich HTML-ish `description`. Caller usually wants
        // plain-ish text; we pass through as-is.
        content: it.description || '',
        score: undefined,         // Brave does not expose a numeric score
        raw_content: undefined,   // No raw content in /web/search
        published_date: it.age,   // Brave returns a human string ("2 days ago")
      })),
    },
  };
}
