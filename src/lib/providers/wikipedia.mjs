// Wikipedia Search adapter — MediaWiki API (action=query&list=search)
//
// Capability:
//   - search: full-text search over Wikipedia articles (only operation)
//   - everything else: NOT supported
//
// KEYLESS by design — the primary free, no-API-key tier. Verified working with
// no auth. Unlike DuckDuckGo's Instant Answer API (which is blank for most
// non-entity queries), Wikipedia full-text search returns relevant article hits
// with snippets for almost any informational query. It is encyclopedic (not a
// general-web SERP), but it is reliable, keyless, and broad — so `search`
// delivers something useful before the user configures any paid provider.
// ctx.key is ignored.
// Language: set SURF_WIKIPEDIA_LANG (default 'en') or pass --search-lang.
// API etiquette REQUIRES a descriptive User-Agent (generic/absent UA gets blocked).
// Docs: https://www.mediawiki.org/wiki/API:Search

const DEFAULT_LANG = process.env.SURF_WIKIPEDIA_LANG || 'en';
const BASE_OVERRIDE = process.env.SURF_WIKIPEDIA_API_BASE; // full URL override (optional)
const DEFAULT_TIMEOUT = Number(process.env.SURF_TIMEOUT_MS) || 45000;

export const wikipediaProvider = {
  name: 'wikipedia',
  keyless: true,
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
    throw Object.assign(new Error(`wikipedia does not support '${op}'`), {
      kind: 'not_supported', statusCode: 0,
    });
  };
}

function apiBase(lang) {
  return BASE_OVERRIDE || `https://${lang}.wikipedia.org/w/api.php`;
}

async function doFetch(query, lang, srlimit, ctx) {
  const url = new URL(apiBase(lang));
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', String(srlimit));
  url.searchParams.set('srprop', 'snippet|timestamp|wordcount');
  url.searchParams.set('srinfo', 'suggestion');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');

  const timeout = ctx.timeout || DEFAULT_TIMEOUT;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        // Wikimedia requires a descriptive, contactable User-Agent.
'User-Agent': `surf-agent-skill/${ctx.version || '7.0.0'} (https://github.com/frederico-kluser/surf-agent-skill)`,
      },
      signal: ctl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    return { status: res.status, ok: res.ok, data, latency_ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError' || /timeout/i.test(e.message)) {
      throw Object.assign(new Error(`Wikipedia request exceeded ${timeout}ms`), { kind: 'network' });
    }
    throw Object.assign(new Error(`Wikipedia network error: ${e.message}`), { kind: 'network' });
  }
}

function mapError(status, body) {
  const msg = (body && body.error && (body.error.info || body.error.code)) || '';
  if (status === 429) return { kind: 'rate_limit_429', statusCode: status, message: msg || 'Wikipedia rate limit' };
  if (status >= 500)  return { kind: 'server_5xx', statusCode: status, message: msg || 'Wikipedia server error' };
  if (status >= 400)  return { kind: 'caller_4xx', statusCode: status, message: msg || `HTTP ${status}` };
  return { kind: 'caller_4xx', statusCode: status, message: msg || `unexpected HTTP ${status}` };
}

function asError(status, body) {
  const m = mapError(status, body);
  return Object.assign(new Error(`wikipedia ${m.kind} (HTTP ${status}): ${m.message}`), m, { body });
}

// Snippets come back as HTML (with <span class="searchmatch"> highlights and
// entities). Strip tags and decode the handful of entities Wikipedia emits.
function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

async function search(args, ctx) {
  const query = args.query;
  if (!query) {
    throw Object.assign(new Error('wikipedia search requires a query'), {
      kind: 'caller_4xx', statusCode: 400,
    });
  }

  const lang = args.searchLang || DEFAULT_LANG;
  let srlimit = 10;
  if (args.max != null) {
    const n = Number(args.max);
    if (Number.isFinite(n) && n > 0) srlimit = Math.min(n, 50);
  }

  const { status, ok, data, latency_ms } = await doFetch(query, lang, srlimit, ctx);
  if (!ok) throw asError(status, data);
  if (data && data.error) throw asError(400, data);

  const hits = (data.query && Array.isArray(data.query.search)) ? data.query.search : [];
  const results = hits.map(it => ({
    url: `https://${lang}.wikipedia.org/?curid=${it.pageid}`,
    title: it.title,
    content: stripHtml(it.snippet),
    score: undefined,        // MediaWiki search doesn't expose a comparable score
    raw_content: undefined,  // full article not fetched for search
    published_date: it.timestamp, // last-edit timestamp (ISO)
  }));

  return {
    provider: 'wikipedia',
    operation: 'search',
    raw: data,
    usage: { credits: 0 }, // keyless / free
    latency_ms,
    data: {
      query,
      // No synthesized answer from full-text search; keep schema parity.
      answer: undefined,
      results,
    },
  };
}
