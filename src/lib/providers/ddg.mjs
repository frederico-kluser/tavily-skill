// DuckDuckGo Instant Answer adapter — https://api.duckduckgo.com/?q=...&format=json
//
// Capability:
//   - search: GET the Instant Answer API (only operation supported)
//   - everything else: NOT supported (DDG IA has no equivalents)
//
// KEYLESS by design — the absolute last-resort tier. IMPORTANT (and commonly
// misunderstood): this is NOT a general web-search / SERP API. Per DuckDuckGo's
// own docs it "is not a full search results API ... beyond our instant answers",
// and "most deep queries (non topic names) will be blank". So it reliably
// answers entity/definition-style queries and otherwise returns an EMPTY result
// set. It sits after `wikipedia` in the chain purely as a costless, ultra-stable
// safety net so a search request is never dropped.
// Auth: none. ctx.key is ignored.
// Docs: https://duckduckgo.com/duckduckgo-help-pages/features/instant-answers-and-other-features

const BASE = process.env.SURF_DDG_API_BASE || 'https://api.duckduckgo.com/';
const DEFAULT_TIMEOUT = Number(process.env.SURF_TIMEOUT_MS) || 45000;

export const ddgProvider = {
  name: 'ddg',
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
    throw Object.assign(new Error(`ddg does not support '${op}'`), {
      kind: 'not_supported', statusCode: 0,
    });
  };
}

async function doFetch(query, ctx) {
  const url = new URL(BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('no_redirect', '1');
  url.searchParams.set('t', 'surf-agent-skill'); // app identifier (DDG etiquette)
  const timeout = ctx.timeout || DEFAULT_TIMEOUT;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Client-Name': `surf-agent-skill/${ctx.version || '5.4.0'}` },
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
      throw Object.assign(new Error(`DuckDuckGo request exceeded ${timeout}ms`), { kind: 'network' });
    }
    throw Object.assign(new Error(`DuckDuckGo network error: ${e.message}`), { kind: 'network' });
  }
}

function mapError(status, body) {
  const msg = (body && (body.message || body.Error)) || '';
  if (status === 429) return { kind: 'rate_limit_429', statusCode: status, message: msg || 'DuckDuckGo rate limit' };
  if (status >= 500)  return { kind: 'server_5xx', statusCode: status, message: msg || 'DuckDuckGo server error' };
  if (status >= 400)  return { kind: 'caller_4xx', statusCode: status, message: msg || `HTTP ${status}` };
  return { kind: 'caller_4xx', statusCode: status, message: msg || `unexpected HTTP ${status}` };
}

function asError(status, body) {
  const m = mapError(status, body);
  return Object.assign(new Error(`ddg ${m.kind} (HTTP ${status}): ${m.message}`), m, { body });
}

// DDG's `Text` fields look like "Apple Inc. - American technology company".
// Derive a short title from the segment before the first " - ".
function deriveTitle(text) {
  if (!text) return undefined;
  const idx = text.indexOf(' - ');
  const head = idx > 0 ? text.slice(0, idx) : text;
  return head.length > 100 ? head.slice(0, 100) : head;
}

// RelatedTopics is a mix of flat { FirstURL, Text } entries and grouped
// { Name, Topics: [...] } entries — flatten to the leaf topics with a URL.
function flattenTopics(topics, out) {
  if (!Array.isArray(topics)) return out;
  for (const t of topics) {
    if (t && Array.isArray(t.Topics)) flattenTopics(t.Topics, out);
    else if (t && t.FirstURL) out.push({ url: t.FirstURL, title: deriveTitle(t.Text), content: t.Text || '' });
  }
  return out;
}

async function search(args, ctx) {
  const query = args.query;
  if (!query) {
    throw Object.assign(new Error('ddg search requires a query'), {
      kind: 'caller_4xx', statusCode: 400,
    });
  }

  const { status, ok, data, latency_ms } = await doFetch(query, ctx);
  if (!ok) throw asError(status, data);

  const answer = data.AbstractText || data.Answer || data.Definition || undefined;

  const results = [];
  // Lead result from the Abstract (Wikipedia-style summary), when present.
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      url: data.AbstractURL,
      title: data.Heading || deriveTitle(data.AbstractText),
      content: data.AbstractText,
      score: undefined, raw_content: undefined, published_date: undefined,
    });
  }
  // Official Results[] (rare) then flattened RelatedTopics[].
  for (const r of (Array.isArray(data.Results) ? data.Results : [])) {
    if (r && r.FirstURL) results.push({ url: r.FirstURL, title: deriveTitle(r.Text), content: r.Text || '', score: undefined, raw_content: undefined, published_date: undefined });
  }
  for (const t of flattenTopics(data.RelatedTopics, [])) {
    results.push({ ...t, score: undefined, raw_content: undefined, published_date: undefined });
  }

  // Dedupe by URL, preserving order (Abstract/Results before RelatedTopics).
  const seen = new Set();
  let deduped = results.filter(r => r.url && !seen.has(r.url) && seen.add(r.url));

  if (args.max != null) {
    const n = Number(args.max);
    if (Number.isFinite(n) && n > 0) deduped = deduped.slice(0, n);
  }

  return {
    provider: 'ddg',
    operation: 'search',
    raw: data,
    usage: { credits: 0 }, // keyless / free
    latency_ms,
    data: {
      query,
      answer,
      // NOTE: frequently [] for non-entity queries — this is expected for the
      // Instant Answer API and is treated as a (thin) success by dispatch.
      results: deduped,
    },
  };
}
