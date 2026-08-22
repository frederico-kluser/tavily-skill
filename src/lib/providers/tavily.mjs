// Tavily adapter — talks to https://api.tavily.com with Authorization: Bearer.

import { clamp, splitList, compactObject, flat } from '../flags.mjs';

const BASE = process.env.SURF_TAVILY_API_BASE || process.env.TAVILY_API_BASE || 'https://api.tavily.com';
const DEFAULT_TIMEOUT = Number(process.env.SURF_TIMEOUT_MS || process.env.TAVILY_TIMEOUT_MS) || 45000;

export const tavilyProvider = {
  name: 'tavily',
  supports: {
    search: true,
    extract: true,
    crawl: true,
    map: true,
    'research-start': true,
    'research-poll': true,
    usage: true,
  },
  search,
  extract,
  crawl,
  map,
  'research-start': researchStart,
  'research-poll': researchPoll,
  usage,
  mapError,
};

function buildHeaders(key, version) {
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Client-Name': `surf-agent-skill/${version || '2.0.0'}`,
  };
}

async function doFetch(path, body, ctx, opts = {}) {
  const method = opts.method || 'POST';
  const timeout = opts.timeoutMs || ctx.timeout || DEFAULT_TIMEOUT;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: buildHeaders(ctx.key, ctx.version),
      body: method === 'POST' ? JSON.stringify(body) : undefined,
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
      throw Object.assign(new Error(`Tavily request exceeded ${timeout}ms`), { kind: 'network' });
    }
    throw Object.assign(new Error(`Tavily network error: ${e.message}`), { kind: 'network' });
  }
}

function mapError(status, body) {
  if (status === 401) return { kind: 'auth', statusCode: status, message: 'invalid Tavily key' };
  if (status === 403) return { kind: 'auth', statusCode: status, message: 'forbidden Tavily key' };
  if (status === 432 || status === 433) return { kind: 'auth', statusCode: status, message: 'Tavily plan/quota limit hit' };
  if (status === 429) return { kind: 'rate_limit_429', statusCode: status, message: 'Tavily rate limit' };
  if (status >= 500) return { kind: 'server_5xx', statusCode: status, message: 'Tavily server error' };
  if (status >= 400) return { kind: 'caller_4xx', statusCode: status, message: flat(body && (body.error || body.detail || body.message)) || `HTTP ${status}` };
  return { kind: 'caller_4xx', statusCode: status, message: `unexpected HTTP ${status}` };
}

function wrap(operation, raw, data, latency_ms) {
  return {
    provider: 'tavily',
    operation,
    raw,
    usage: { credits: raw && raw.usage && raw.usage.credits },
    latency_ms,
    data,
  };
}

async function search(args, ctx) {
  // Mode (canonical) → Tavily search_depth. Falls back to --depth (legacy
  // alias) and finally to 'basic'.
  const depth = args.mode === 'fast'   ? 'fast'
              : args.mode === 'normal' ? 'basic'
              : args.mode === 'slow'   ? 'advanced'
              : (args.depth || 'basic');

  const body = compactObject({
    query: args.query,
    search_depth: depth,
    max_results: clamp(Number(args.max) || 5, 1, 20),
    topic: args.topic,
    time_range: args.time,
    start_date: args.startDate,
    end_date: args.endDate,
    include_domains: splitList(args.domains),
    exclude_domains: splitList(args.excludeDomains),
    country: args.country,
    include_answer: args.answer === true ? 'basic' : args.answer,
    include_raw_content: args.raw === true ? 'markdown' : args.raw,
    include_images: !!args.images,
    include_image_descriptions: !!args.imageDesc,
    include_favicon: !!args.favicon,
    auto_parameters: !!args.auto,
    exact_match: !!args.exactMatch,
    include_usage: true,
  });
  const { status, ok, data, latency_ms } = await doFetch('/search', body, ctx);
  if (!ok) throw asError(status, data);
  return wrap('search', data, {
    query: data.query || args.query,
    answer: data.answer,
    results: (data.results || []).map(it => ({
      url: it.url,
      title: it.title,
      content: it.content || '',
      score: it.score,
      raw_content: it.raw_content,
      published_date: it.published_date,
    })),
  }, latency_ms);
}

async function extract(args, ctx) {
  const body = compactObject({
    urls: args.urls,
    extract_depth: args.depth || 'basic',
    format: args.format || 'markdown',
    include_images: !!args.images,
    include_favicon: !!args.favicon,
    query: args.query,
    chunks_per_source: args.chunks ? Number(args.chunks) : undefined,
    timeout: args.extractTimeout ? Number(args.extractTimeout) : undefined,
    include_usage: true,
  });
  const { status, ok, data, latency_ms } = await doFetch('/extract', body, ctx);
  if (!ok) throw asError(status, data);
  return wrap('extract', data, {
    results: (data.results || []).map(it => ({
      url: it.url,
      raw_content: it.raw_content || '',
      title: it.title,
      images: it.images,
    })),
    failed: (data.failed_results || []).map(f => ({
      url: f.url || (typeof f === 'string' ? f : ''),
      reason: f.error || 'unknown',
    })),
  }, latency_ms);
}

async function crawl(args, ctx) {
  const body = compactObject({
    url: args.url,
    max_depth: clamp(Number(args.maxDepth) || 1, 1, 5),
    max_breadth: clamp(Number(args.maxBreadth) || 20, 1, 500),
    limit: clamp(Number(args.limit) || 50, 1, 200),
    instructions: args.instructions,
    select_paths: splitList(args.selectPaths),
    select_domains: splitList(args.selectDomains),
    exclude_paths: splitList(args.excludePaths),
    exclude_domains: splitList(args.excludeDomains),
    allow_external: !!args.allowExternal,
    include_images: !!args.images,
    categories: splitList(args.categories),
    extract_depth: args.extractDepth || 'basic',
    format: args.format || 'markdown',
    query: args.query,
    chunks_per_source: args.chunks ? Number(args.chunks) : undefined,
    timeout: args.timeout ? Number(args.timeout) : undefined,
    include_usage: true,
  });
  const { status, ok, data, latency_ms } = await doFetch('/crawl', body, ctx, { timeoutMs: 50000 });
  if (!ok) throw asError(status, data);
  return wrap('crawl', data, {
    base_url: data.base_url || args.url,
    results: (data.results || []).map(it => typeof it === 'string'
      ? { url: it }
      : { url: it.url, raw_content: it.raw_content }),
  }, latency_ms);
}

async function map(args, ctx) {
  const body = compactObject({
    url: args.url,
    max_depth: clamp(Number(args.maxDepth) || 1, 1, 5),
    max_breadth: clamp(Number(args.maxBreadth) || 20, 1, 500),
    limit: clamp(Number(args.limit) || 50, 1, 500),
    instructions: args.instructions,
    select_paths: splitList(args.selectPaths),
    select_domains: splitList(args.selectDomains),
    exclude_paths: splitList(args.excludePaths),
    exclude_domains: splitList(args.excludeDomains),
    allow_external: !!args.allowExternal,
    categories: splitList(args.categories),
    timeout: args.timeout ? Number(args.timeout) : undefined,
    include_usage: true,
  });
  const { status, ok, data, latency_ms } = await doFetch('/map', body, ctx);
  if (!ok) throw asError(status, data);
  const urls = (data.results || []).map(it => typeof it === 'string' ? it : it.url).filter(Boolean);
  return wrap('map', data, { base_url: data.base_url || args.url, urls }, latency_ms);
}

async function researchStart(args, ctx) {
  const body = compactObject({
    input: args.input,
    model: args.model || 'auto',
    citation_format: args.citationFormat || 'numbered',
    stream: false,
    output_schema: args.outputSchema,
  });
  const { status, ok, data, latency_ms } = await doFetch('/research', body, ctx, { timeoutMs: 30000 });
  if (!ok) throw asError(status, data);
  return wrap('research-start', data, {
    request_id: `tvly:${data.request_id}`,
    provider_run_id: data.request_id,
    status: data.status || 'pending',
    model: data.model || body.model,
  }, latency_ms);
}

async function researchPoll(args, ctx) {
  const id = args.providerRunId;
  const { status, ok, data, latency_ms } = await doFetch(`/research/${id}`, null, ctx, { method: 'GET', timeoutMs: 15000 });
  if (!ok) throw asError(status, data);
  return wrap('research-poll', data, {
    request_id: `tvly:${id}`,
    provider_run_id: id,
    status: data.status,
    model: data.model,
    content: data.content,
    sources: (data.sources || []).map(s => ({ url: s.url, title: s.title })),
    error: data.error,
  }, latency_ms);
}

async function usage(_args, ctx) {
  const { status, ok, data, latency_ms } = await doFetch('/usage', null, ctx, { method: 'GET', timeoutMs: 15000 });
  if (!ok) throw asError(status, data);
  return wrap('usage', data, data, latency_ms);
}

function asError(status, body) {
  const m = mapError(status, body);
  return Object.assign(new Error(`tavily ${m.kind} (HTTP ${status}): ${m.message}`), m, { body });
}
