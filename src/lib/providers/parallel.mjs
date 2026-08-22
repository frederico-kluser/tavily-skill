// Parallel AI adapter — talks to https://api.parallel.ai with x-api-key header.
// Capability notes:
//   - search:           POST /v1/search
//   - extract:          POST /v1beta/extract  (beta endpoint)
//   - crawl:            NOT supported
//   - map:              NOT supported
//   - research-start:   POST /v1/tasks/runs   (async; returns run_id)
//   - research-poll:    GET  /v1/tasks/runs/{id}  + GET /v1/tasks/runs/{id}/result
//   - usage:            NOT documented publicly
// Auth: header `x-api-key: <key>` (NOT Bearer).
// Error body: { "type":"error", "error":{ "ref_id":"...", "message":"...", "detail":{} } }

import { clamp, compactObject, flat, splitList } from '../flags.mjs';

const BASE = process.env.SURF_PARALLEL_API_BASE || 'https://api.parallel.ai';
const DEFAULT_TIMEOUT = Number(process.env.SURF_TIMEOUT_MS) || 45000;

const DEPTH_TO_PROCESSOR = {
  'ultra-fast': 'lite',
  'fast': 'lite',
  'basic': 'lite',
  'advanced': 'base',
};

const RESEARCH_MODEL_TO_PROCESSOR = {
  mini: 'lite',
  auto: 'base',
  pro: 'pro',
  ultra: 'ultra',
};

export const parallelProvider = {
  name: 'parallel',
  supports: {
    search: true,
    extract: true,
    crawl: false,
    map: false,
    'research-start': true,
    'research-poll': true,
    usage: false,
  },
  search,
  extract,
  crawl: notSupported('crawl'),
  map: notSupported('map'),
  'research-start': researchStart,
  'research-poll': researchPoll,
  usage: notSupported('usage'),
  mapError,
};

function notSupported(op) {
  return async () => {
    throw Object.assign(new Error(`parallel does not support '${op}'`), {
      kind: 'not_supported', statusCode: 0,
    });
  };
}

function buildHeaders(key, version) {
  return {
    'x-api-key': key,
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
      throw Object.assign(new Error(`Parallel request exceeded ${timeout}ms`), { kind: 'network' });
    }
    throw Object.assign(new Error(`Parallel network error: ${e.message}`), { kind: 'network' });
  }
}

function extractMessage(body) {
  if (!body) return '';
  if (body.error) {
    if (typeof body.error === 'string') return body.error;
    const parts = [];
    if (body.error.message) parts.push(body.error.message);
    // Parallel returns detailed validation errors at body.error.detail.errors[]
    // with shape { type, loc: ["body","field"], msg, input }. Surface them so
    // schema mismatches are debuggable without --raw-json.
    const errs = body.error.detail && body.error.detail.errors;
    if (Array.isArray(errs) && errs.length) {
      for (const e of errs) {
        const loc = Array.isArray(e.loc) ? e.loc.join('.') : '';
        parts.push(`${loc}: ${e.msg}`);
      }
    } else if (body.error.detail) {
      parts.push(flat(body.error.detail));
    }
    return parts.filter(Boolean).join(' — ');
  }
  return flat(body.message) || flat(body.detail) || '';
}

function mapError(status, body) {
  const msg = extractMessage(body);
  if (status === 401) return { kind: 'auth', statusCode: status, message: 'invalid Parallel key' };
  if (status === 402) return { kind: 'auth', statusCode: status, message: 'Parallel: insufficient credits' };
  if (status === 403) {
    // 403 may be auth OR "invalid processor" depending on body. The latter is a
    // caller error — switching keys won't help.
    if (/processor/i.test(msg)) return { kind: 'caller_4xx', statusCode: status, message: msg };
    return { kind: 'auth', statusCode: status, message: msg || 'forbidden' };
  }
  if (status === 429) return { kind: 'rate_limit_429', statusCode: status, message: msg || 'Parallel rate limit' };
  if (status >= 500) return { kind: 'server_5xx', statusCode: status, message: msg || 'Parallel server error' };
  if (status >= 400) return { kind: 'caller_4xx', statusCode: status, message: msg || `HTTP ${status}` };
  return { kind: 'caller_4xx', statusCode: status, message: msg || `unexpected HTTP ${status}` };
}

function asError(status, body) {
  const m = mapError(status, body);
  return Object.assign(new Error(`parallel ${m.kind} (HTTP ${status}): ${m.message}`), m, { body });
}

function wrap(operation, raw, data, latency_ms) {
  return {
    provider: 'parallel',
    operation,
    raw,
    usage: { credits: raw && raw.usage && (raw.usage.credits ?? raw.usage.total_credits) },
    latency_ms,
    data,
  };
}

async function search(args, ctx) {
  const queries = args.searchQueries
    ? (Array.isArray(args.searchQueries) ? args.searchQueries : splitList(args.searchQueries))
    : (args.query ? [args.query] : []);
  if (!queries.length) throw Object.assign(new Error('search requires query or --queries'), { kind: 'caller_4xx', statusCode: 400 });

  // Parallel POST /v1/search currently accepts ONLY { objective, search_queries }.
  // Any other field (processor, max_results, source_policy, ...) is rejected
  // with "Extra inputs are not permitted". Tavily-only knobs like --depth,
  // --max, --domains are silently ignored on this provider — that's expected.
  // Verified against api.parallel.ai 2026-05-20; if Parallel expands the
  // schema later, add fields here.
  const body = {
    objective: args.objective || args.query || queries[0],
    search_queries: queries,
  };

  const { status, ok, data, latency_ms } = await doFetch('/v1/search', body, ctx);
  if (!ok) throw asError(status, data);

  return wrap('search', data, {
    query: args.query || queries.join(' | '),
    answer: undefined,
    results: (data.results || []).map(it => ({
      url: it.url,
      title: it.title,
      content: Array.isArray(it.excerpts) ? it.excerpts.join('\n\n') : (it.excerpts || it.snippet || ''),
      score: undefined,
      raw_content: it.full_content,
      published_date: it.publish_date,
    })),
  }, latency_ms);
}

async function extract(args, ctx) {
  if (!Array.isArray(args.urls) || args.urls.length === 0) {
    throw Object.assign(new Error('extract requires at least 1 URL'), { kind: 'caller_4xx', statusCode: 400 });
  }
  const body = compactObject({
    urls: args.urls,
    objective: args.query,
    excerpts: args.depth !== 'advanced',
    full_content: args.depth === 'advanced',
  });
  const { status, ok, data, latency_ms } = await doFetch('/v1beta/extract', body, ctx);
  if (!ok) throw asError(status, data);
  return wrap('extract', data, {
    results: (data.results || []).map(it => ({
      url: it.url,
      raw_content: it.full_content || (Array.isArray(it.excerpts) ? it.excerpts.join('\n\n') : ''),
      title: it.title,
      images: undefined,
    })),
    failed: (data.errors || []).map(e => ({
      url: e.url || (typeof e === 'string' ? e : ''),
      reason: e.message || e.error || 'unknown',
    })),
  }, latency_ms);
}

async function researchStart(args, ctx) {
  const processor = args.processor || RESEARCH_MODEL_TO_PROCESSOR[args.model || 'auto'] || 'base';
  const body = compactObject({
    input: args.input,
    processor,
    task_spec: args.outputSchema ? { output_schema: args.outputSchema } : undefined,
  });
  const { status, ok, data, latency_ms } = await doFetch('/v1/tasks/runs', body, ctx, { timeoutMs: 30000 });
  if (!ok) throw asError(status, data);
  return wrap('research-start', data, {
    request_id: `pllx:${data.run_id}`,
    provider_run_id: data.run_id,
    status: data.status || 'queued',
    model: processor,
  }, latency_ms);
}

async function researchPoll(args, ctx) {
  const id = args.providerRunId;
  // 1) status check
  const head = await doFetch(`/v1/tasks/runs/${id}`, null, ctx, { method: 'GET', timeoutMs: 15000 });
  if (!head.ok) throw asError(head.status, head.data);

  const headData = head.data;
  const status = String(headData.status || '').toLowerCase();
  const isCompleted = status === 'completed' || status === 'success';
  const isFailed = status === 'failed' || status === 'errored' || status === 'error';

  // Map Parallel statuses to normalized vocabulary.
  let normStatus = status;
  if (isCompleted) normStatus = 'completed';
  else if (isFailed) normStatus = 'failed';
  else if (status === 'queued' || status === 'pending') normStatus = 'pending';
  else normStatus = 'running';

  let content, sources, errorMsg;
  if (isCompleted) {
    const res = await doFetch(`/v1/tasks/runs/${id}/result`, null, ctx, { method: 'GET', timeoutMs: 20000 });
    if (!res.ok) throw asError(res.status, res.data);
    const r = res.data || {};
    const output = r.output || r.result || {};
    content = typeof output === 'string' ? output : (output.content || output.text || JSON.stringify(output));
    sources = (output.basis || r.basis || []).map(s => ({
      url: s.url || s.source_url || '',
      title: s.title,
    })).filter(s => s.url);
  } else if (isFailed) {
    errorMsg = headData.error || extractMessage(headData) || 'task failed';
  }

  return wrap('research-poll', headData, {
    request_id: `pllx:${id}`,
    provider_run_id: id,
    status: normStatus,
    model: headData.processor,
    content,
    sources,
    error: errorMsg,
  }, head.latency_ms);
}
