#!/usr/bin/env node
// tavily skill CLI — single-file, zero deps, Node 18+
import { mkdir, readFile, writeFile, unlink, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '1.1.0';
const API = process.env.TAVILY_API_BASE || 'https://api.tavily.com';
const KEY = process.env.TAVILY_API_KEY;
const CACHE_DIR = join(homedir(), '.cache', 'tavily-skill');
const AUDIT_LOG = join(CACHE_DIR, 'audit.log');
const USAGE_LOG = join(CACHE_DIR, 'usage.jsonl');
const TTL_MS = (Number(process.env.TAVILY_CACHE_TTL) || 21600) * 1000; // 6h
const TIMEOUT = Number(process.env.TAVILY_TIMEOUT_MS) || 45000;
const MAX_RAW = Number(process.env.TAVILY_MAX_CONTENT_CHARS) || 1500;
const EXPENSIVE_OK = process.env.TAVILY_ALLOW_EXPENSIVE === '1';

const HELP = `tvly — Tavily API CLI skill

Commands:
  search, extract, crawl, map,
  research-start, research-poll, research,
  cache-clear, cost, usage

Common flags:
  --json                 Print raw JSON
  --no-cache             Skip local response cache
  --confirm-expensive    Allow commands estimated above 10 credits

Notes:
  - tvly --help and tvly --version work without TAVILY_API_KEY
  - cache-clear and cost also work without TAVILY_API_KEY
  - Docs: ~/.agents/skills/tavily/SKILL.md`;

function die(msg, code = 1) {
  process.stderr.write(`❌ Error: ${msg}\n`);
  process.exit(code);
}
function err(msg) {
  process.stderr.write(`❌ Error: ${msg}\n`);
}
function out(msg) {
  process.stdout.write(msg + (msg.endsWith('\n') ? '' : '\n'));
}
function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}
function ceilDiv(a, b) {
  return Math.ceil(a / b);
}
function splitList(s) {
  return typeof s === 'string' ? s.split(',').map(x => x.trim()).filter(Boolean) : undefined;
}
function trunc(s, n = MAX_RAW) {
  return !s ? '' : (s.length > n ? s.slice(0, n) + '…' : s);
}
function flat(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return flat(v.message) || flat(v.error) || flat(v.detail) || JSON.stringify(v);
}
function needsApiKey(cmd) {
  return !new Set(['cache-clear', 'cost']).has(cmd);
}

async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}
async function appendJsonl(path, entry) {
  await ensureCacheDir();
  await appendFile(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}
async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}
async function audit(event) {
  await appendJsonl(AUDIT_LOG, event);
}
async function recordUsage(event) {
  await appendJsonl(USAGE_LOG, event);
}

function cacheKey(endpoint, body) {
  return createHash('sha256').update(endpoint + JSON.stringify(body)).digest('hex').slice(0, 24);
}
async function cacheGet(key) {
  const f = join(CACHE_DIR, key + '.json');
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(await readFile(f, 'utf8'));
    if (Date.now() - raw.ts > TTL_MS) return null;
    return raw.data;
  } catch {
    return null;
  }
}
async function cacheSet(key, data) {
  await ensureCacheDir();
  await writeFile(join(CACHE_DIR, key + '.json'), JSON.stringify({ ts: Date.now(), data }));
}

function estimateCredits(cmd, pos, flags) {
  switch (cmd) {
    case 'search':
      return (flags.depth === 'advanced' || flags.auto) ? 2 : 1;
    case 'extract': {
      const urls = pos.length;
      const rate = flags.depth === 'advanced' ? 2 : 1;
      return ceilDiv(Math.max(urls, 1), 5) * rate;
    }
    case 'map': {
      const limit = clamp(Number(flags.limit) || 50, 1, 500);
      const rate = flags.instructions ? 2 : 1;
      return ceilDiv(limit, 10) * rate;
    }
    case 'crawl': {
      const limit = clamp(Number(flags.limit) || 50, 1, 200);
      const mapRate = flags.instructions ? 2 : 1;
      const extractRate = flags['extract-depth'] === 'advanced' ? 2 : 1;
      return ceilDiv(limit, 10) * mapRate + ceilDiv(limit, 5) * extractRate;
    }
    case 'research-start':
    case 'research': {
      const model = flags.model || (cmd === 'research' ? 'mini' : 'auto');
      if (model === 'mini') return 15;
      return 50; // auto/pro can exceed 10 credits; use safe upper-bound guard
    }
    default:
      return 0;
  }
}
async function guardExpensive(cmd, pos, flags) {
  if (EXPENSIVE_OK || flags['confirm-expensive']) return;
  const estimate = estimateCredits(cmd, pos, flags);
  if (estimate > 10) {
    throw new Error(
      `This command is estimated to cost about ${estimate} credits. Ask the user first, then re-run with --confirm-expensive (or set TAVILY_ALLOW_EXPENSIVE=1).`
    );
  }
}

async function call(endpoint, body, { method = 'POST', noCache = false, timeoutMs = TIMEOUT } = {}) {
  const key = cacheKey(method + endpoint, body);
  if (!noCache && method === 'POST') {
    const hit = await cacheGet(key);
    if (hit) {
      await audit({ endpoint, cache: 'hit' });
      await recordUsage({ endpoint, credits: 0, cached: true });
      return hit;
    }
  }

  let attempt = 0;
  let lastErr;
  while (attempt < 3) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(`${API}${endpoint}`, {
        method,
        headers: {
          'Authorization': `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          'X-Client-Name': `tavily-skill/${VERSION}`
        },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: ctl.signal
      });
      clearTimeout(t);

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!res.ok) {
        if (res.status === 429 && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1) ** 2));
          attempt++;
          continue;
        }
        await audit({ endpoint, status: res.status, error: data });
        throw new Error(`HTTP ${res.status}: ${flat(data.error) || flat(data.detail) || flat(data.message) || text.slice(0, 200)}`);
      }

      const credits = data.usage?.credits;
      await audit({ endpoint, status: res.status, credits, request_id: data.request_id });
      if (credits != null) {
        await recordUsage({ endpoint, credits, cached: false, request_id: data.request_id || null });
      }
      if (!noCache && method === 'POST') await cacheSet(key, data);
      return data;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (e.name === 'AbortError' || /timeout/i.test(e.message)) {
        throw new Error(`Tavily request exceeded ${timeoutMs}ms — use research-start/research-poll for long jobs`);
      }
      if (attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1) ** 2));
      attempt++;
    }
  }
  throw lastErr;
}

function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags[k] = true;
      else { flags[k] = next; i++; }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function fmtSearch(r) {
  let md = `# Search: ${r.query}\n\n`;
  if (r.answer) md += `**Answer:** ${r.answer}\n\n`;
  (r.results || []).forEach((it, i) => {
    md += `## [${i + 1}] ${it.title}\n${it.url}\n*score: ${it.score?.toFixed?.(2) ?? '—'}*\n\n${trunc(it.content)}\n\n`;
    if (it.raw_content) md += `<details><summary>raw</summary>\n\n${trunc(it.raw_content, 3000)}\n\n</details>\n\n`;
  });
  if (r.usage?.credits != null) md += `\n_credits: ${r.usage.credits}_\n`;
  return md;
}
function fmtExtract(r) {
  let md = '# Extracted content\n\n';
  (r.results || []).forEach((it, i) => {
    md += `## [${i + 1}] ${it.url}\n\n${trunc(it.raw_content, 3000)}\n\n`;
  });
  if (r.failed_results?.length) md += `\n**Failed:** ${r.failed_results.map(f => f.url || f).join(', ')}\n`;
  if (r.usage?.credits != null) md += `\n_credits: ${r.usage.credits}_\n`;
  return md;
}
function fmtCrawlMap(r, label) {
  let md = `# ${label}: ${r.base_url || ''}\n\n`;
  (r.results || []).forEach((it, i) => {
    if (typeof it === 'string') md += `- ${it}\n`;
    else {
      md += `## [${i + 1}] ${it.url}\n\n`;
      if (it.raw_content) md += `${trunc(it.raw_content)}\n\n`;
    }
  });
  if (r.usage?.credits != null) md += `\n_credits: ${r.usage.credits}_\n`;
  return md;
}
function fmtResearch(r) {
  if (r.status !== 'completed') return `Research **${r.status}** (request_id=${r.request_id})\n`;
  let md = `# Research report\n\n${r.content}\n\n## Sources\n`;
  (r.sources || []).forEach((s, i) => {
    md += `${i + 1}. [${s.title || s.url}](${s.url})\n`;
  });
  return md;
}

const cmds = {
  async search([query], flags) {
    if (!query) die('Usage: tvly search "query" [flags]');
    const body = {
      query,
      search_depth: flags.depth || 'basic',
      max_results: clamp(Number(flags.max) || 5, 1, 20),
      topic: flags.topic,
      time_range: flags.time,
      start_date: flags['start-date'],
      end_date: flags['end-date'],
      include_domains: splitList(flags.domains),
      exclude_domains: splitList(flags.exclude),
      country: flags.country,
      include_answer: flags.answer === true ? 'basic' : flags.answer,
      include_raw_content: flags.raw === true ? 'markdown' : flags.raw,
      include_images: !!flags.images,
      include_image_descriptions: !!flags['image-desc'],
      include_favicon: !!flags.favicon,
      auto_parameters: !!flags.auto,
      exact_match: !!flags['exact-match'],
      include_usage: true
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    const r = await call('/search', body, { noCache: !!flags['no-cache'] });
    out(flags.json ? JSON.stringify(r, null, 2) : fmtSearch(r));
  },

  async extract(urls, flags) {
    if (!urls.length) die('Usage: tvly extract <url1> [url2 ...]');
    if (urls.length > 20) die('Tavily extract supports at most 20 URLs per call.');
    const body = {
      urls,
      extract_depth: flags.depth || 'basic',
      format: flags.format || 'markdown',
      include_images: !!flags.images,
      include_favicon: !!flags.favicon,
      query: flags.query,
      chunks_per_source: flags.chunks ? Number(flags.chunks) : undefined,
      timeout: flags['extract-timeout'] ? Number(flags['extract-timeout']) : undefined,
      include_usage: true
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    const r = await call('/extract', body, { noCache: !!flags['no-cache'] });
    out(flags.json ? JSON.stringify(r, null, 2) : fmtExtract(r));
  },

  async crawl([url], flags) {
    if (!url) die('Usage: tvly crawl <url> [flags]');
    const body = {
      url,
      max_depth: clamp(Number(flags['max-depth']) || 1, 1, 5),
      max_breadth: clamp(Number(flags['max-breadth']) || 20, 1, 500),
      limit: clamp(Number(flags.limit) || 50, 1, 200),
      instructions: flags.instructions,
      select_paths: splitList(flags['select-paths']),
      select_domains: splitList(flags['select-domains']),
      exclude_paths: splitList(flags['exclude-paths']),
      exclude_domains: splitList(flags['exclude-domains']),
      allow_external: !!flags['allow-external'],
      include_images: !!flags.images,
      categories: splitList(flags.categories),
      extract_depth: flags['extract-depth'] || 'basic',
      format: flags.format || 'markdown',
      query: flags.query,
      chunks_per_source: flags.chunks ? Number(flags.chunks) : undefined,
      timeout: flags.timeout ? Number(flags.timeout) : undefined,
      include_usage: true
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    const r = await call('/crawl', body, { noCache: !!flags['no-cache'], timeoutMs: 50000 });
    out(flags.json ? JSON.stringify(r, null, 2) : fmtCrawlMap(r, 'Crawl'));
  },

  async map([url], flags) {
    if (!url) die('Usage: tvly map <url> [flags]');
    const body = {
      url,
      max_depth: clamp(Number(flags['max-depth']) || 1, 1, 5),
      max_breadth: clamp(Number(flags['max-breadth']) || 20, 1, 500),
      limit: clamp(Number(flags.limit) || 50, 1, 500),
      instructions: flags.instructions,
      select_paths: splitList(flags['select-paths']),
      select_domains: splitList(flags['select-domains']),
      exclude_paths: splitList(flags['exclude-paths']),
      exclude_domains: splitList(flags['exclude-domains']),
      allow_external: !!flags['allow-external'],
      categories: splitList(flags.categories),
      timeout: flags.timeout ? Number(flags.timeout) : undefined,
      include_usage: true
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    const r = await call('/map', body, { noCache: !!flags['no-cache'] });
    out(flags.json ? JSON.stringify(r, null, 2) : fmtCrawlMap(r, 'Map'));
  },

  async 'research-start'(inputs, flags) {
    const input = inputs.join(' ').trim();
    if (!input) die('Usage: tvly research-start "topic" [--model mini|pro|auto]');
    const body = {
      input,
      model: flags.model || 'auto',
      citation_format: flags.citations || 'numbered',
      stream: false
    };
    if (flags.schema) {
      try {
        body.output_schema = JSON.parse(await readFile(flags.schema, 'utf8'));
      } catch (e) {
        die(`Cannot read schema file ${flags.schema}: ${e.message}`);
      }
    }
    const r = await call('/research', body, { noCache: true, timeoutMs: 30000 });
    await mkdir('/tmp', { recursive: true }).catch(() => {});
    await writeFile(`/tmp/tvly-${r.request_id}.json`, JSON.stringify({ started: Date.now(), input, model: body.model }));
    out(flags.json
      ? JSON.stringify(r, null, 2)
      : `**Research started**\n- request_id: \`${r.request_id}\`\n- model: ${r.model}\n- status: ${r.status}\n\nPoll with: \`tvly research-poll ${r.request_id}\``);
  },

  async 'research-poll'([id], flags) {
    if (!id) die('Usage: tvly research-poll <request_id>');
    const r = await call(`/research/${id}`, null, { method: 'GET', noCache: true, timeoutMs: 15000 });
    if (r.status === 'completed') {
      try { await unlink(`/tmp/tvly-${id}.json`); } catch {}
    }
    out(flags.json ? JSON.stringify(r, null, 2) : fmtResearch(r));
  },

  async research(inputs, flags) {
    const input = inputs.join(' ').trim();
    if (!input) die('Usage: tvly research "topic"');
    const model = flags.model || 'mini';
    if (model === 'pro') die('Refusing sync research with model=pro (would exceed timeout). Use research-start + research-poll.');
    const startResp = await call('/research', {
      input,
      model,
      citation_format: flags.citations || 'numbered'
    }, { noCache: true, timeoutMs: 20000 });
    const id = startResp.request_id;
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const r = await call(`/research/${id}`, null, { method: 'GET', noCache: true, timeoutMs: 10000 });
      if (r.status === 'completed' || r.status === 'failed') {
        out(flags.json ? JSON.stringify(r, null, 2) : fmtResearch(r));
        return;
      }
    }
    out(`**Research did not finish in 50s.** Continue with: \`tvly research-poll ${id}\``);
  },

  async 'cache-clear'() {
    if (!existsSync(CACHE_DIR)) return out('Cache empty.');
    const files = await readdir(CACHE_DIR);
    let n = 0;
    for (const f of files) {
      if (f.endsWith('.json')) {
        await unlink(join(CACHE_DIR, f));
        n++;
      }
    }
    out(`Cleared ${n} cache entr${n === 1 ? 'y' : 'ies'}.`);
  },

  async cost(_pos, flags) {
    if (flags.reset) {
      try { await unlink(USAGE_LOG); } catch {}
      out(flags.json ? JSON.stringify({ reset: true }, null, 2) : 'Reset local usage ledger.');
      return;
    }
    const entries = await readJsonl(USAGE_LOG);
    const total = entries.reduce((sum, e) => sum + (Number(e.credits) || 0), 0);
    const liveCalls = entries.filter(e => !e.cached);
    const cacheHits = entries.filter(e => e.cached).length;
    if (flags.json) {
      out(JSON.stringify({
        totalCredits: total,
        entries: entries.length,
        liveCalls: liveCalls.length,
        cacheHits,
        recent: entries.slice(-20)
      }, null, 2));
      return;
    }
    let md = `**Local recorded credits:** ${total}\n`;
    md += `- live API calls: ${liveCalls.length}\n`;
    md += `- cache hits: ${cacheHits}\n`;
    if (!entries.length) {
      md += '\n_No local usage recorded yet._\n';
    } else {
      md += '\n**Recent calls**\n';
      for (const e of entries.slice(-20)) {
        md += `- ${e.ts} ${e.endpoint}: ${e.credits}${e.cached ? ' (cache hit)' : ''}\n`;
      }
    }
    md += '\nUse `tvly cost --reset` to clear the local ledger.';
    out(md);
  },

  async usage(_pos, flags) {
    const r = await call('/usage', null, { method: 'GET', noCache: true });
    out(flags.json ? JSON.stringify(r, null, 2) : JSON.stringify(r, null, 2));
  }
};

const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === '--help' || cmd === '-h') {
  out(HELP);
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  out(VERSION);
  process.exit(0);
}

const fn = cmds[cmd];
if (!fn) die(`Unknown command: ${cmd}`);

const { pos, flags } = parseFlags(rest);
if (!KEY && needsApiKey(cmd)) die('TAVILY_API_KEY env var is required. Get a key at https://app.tavily.com');

guardExpensive(cmd, pos, flags)
  .then(() => fn(pos, flags))
  .catch(e => {
    err(e.message || String(e));
    process.exit(1);
  });
