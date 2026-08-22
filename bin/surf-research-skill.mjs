#!/usr/bin/env node
// surf-research-skill — multi-provider web-skill CLI. Routes search/extract/crawl/map/research
// across Tavily and Parallel AI with automatic key + provider fallback.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { parseFlags, sleep, clamp, maskKey } from '../src/lib/flags.mjs';
import { dispatch, DispatchError } from '../src/lib/dispatch.mjs';
import { mapPool } from '../src/lib/pool.mjs';
import { formatFor } from '../src/lib/format.mjs';
import { runKeysSubcommand } from '../src/lib/keys-cmd.mjs';
import { cacheClear } from '../src/lib/cache.mjs';
import { readUsage, USAGE_LOG } from '../src/lib/audit.mjs';
import { migrateLegacy, loadState, saveStateAtomic } from '../src/lib/state.mjs';
import { runSetup } from '../src/lib/setup.mjs';
import { runProjectConfig, formatProjectConfigResult } from '../src/lib/project-config.mjs';
import { providerFromRequestId } from '../src/lib/providers/index.mjs';
import { progress, setSilent } from '../src/lib/progress.mjs';
import { runAiCommand } from '../src/lib/ai/cli.mjs';
import { runAiSetup } from '../src/lib/ai/setup.mjs';

const VERSION = '5.4.0';

// Catch SIGTERM/SIGINT so a harness-driven kill surfaces a useful message
// instead of dying silently. This is defense-in-depth: dispatch already
// tries to abort early via the self-budget check.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    process.stderr.write(
      `❌ Error [KilledBySignal]: surf-research-skill received ${sig}. ` +
      `If this came from the agent's bash timeout, run 'surf-research-skill project-config' ` +
      `in this project to raise the limit, or use 'research-start' + 'research-poll' for long jobs.\n`
    );
    process.exit(143); // 128 + 15 (SIGTERM convention)
  });
}

const HELP = `surf-research-skill — multi-provider web skill (Tavily + Parallel AI)

surf-ai (autonomous research — the CLI runs the whole loop):
  surf-search-normal <question>    ONE round: LLM plans the queries → they all
                                   run in parallel → LLM writes the answer.
                                   Fitted inside the agent's bash timeout.
  surf-search-unlimit <question>   As many rounds as the question needs: after
                                   each round the LLM lists what is still open
                                   and launches the next wave. No self-deadline.
  ai <question> --mode normal|unlimit      (same thing, explicit mode)
  ai-setup [--key sk-or-v1-...]    Store the OpenRouter key surf-ai needs.

  Brief flags (give the model your actual situation — this is what makes the
  answer usable instead of generic):
    --task "<what you are building/doing right now>"
    --goal "<what you need out of this research>"
    --insights "<what you already believe — it gets verified, not assumed>"
    --deliverable "<the exact shape of answer you want back>"
    --brief-file <f.json>   {"question","task","goal","insights","deliverable"}
    --ai-model <slug>       override the LLM (default deepseek/deepseek-v4-pro)
    --max-rounds N          unlimit only (default 6, hard cap 50)
    --max-queries N         queries per round (normal 6, unlimit 10)
    --concurrency N         parallel searches (normal 6, unlimit 8)
    --ledger                append the per-query coverage table
    --out <file>            also write the answer to a file

Commands:
  setup                       Interactive onboarding wizard (TTY required)
  project-config [--harness <copilot|claude|pi|all>] [--yes]
                              Write per-project bash-timeout config so the
                              harness used in this project doesn't kill us.
                              Auto-detects via .github/, .claude/, .pi/.
                              REQUIRED for GH Copilot CLI projects.
  search <q> [<q2> ...]       Web search. Multiple positional args = batch
                              (sequential, partial failures reported inline).
  search-parallel <q> [q2...] Fan out MANY searches concurrently (bounded
                              [--queries-file F.json] [--concurrency 6]
                              worker pool, partial-failure tolerant). Accepts
                              positional queries and/or a JSON queries file
                              ([ "q", {"q":"...","id":"...","sub":"..."} ]).
  extract <url> [url ...]     Fetch & extract content from URLs
                              [--urls-file F.json] (JSON array / newline list)
  crawl <url>                 Crawl a site (Tavily only)
  map <url>                   Discover URLs on a site (Tavily only)
  research <topic>            Sync deep research (~50s budget)
                              [--model mini|auto|pro|ultra] or [--processor <tier>]
                              (tier bypasses --model: lite|base|core|core2x|
                              pro|ultra|ultra2x|ultra4x|ultra8x, any with
                              a -fast suffix — see references/parallel-api.md)
  research-start <topic>      Start async research; returns request_id
                              [--model ...] or [--processor <tier>] (see above)
  research-poll <request_id>  Poll a research job
  usage --provider <name>     Account usage (per provider)
  cache-clear                 Purge response cache
  cost [--reset]              Local credit ledger
  keys <add|remove|list|reset|clear> [...]

Global flags:
  --provider <tavily|parallel|brave>  Force provider, disables fallback
  --mode <fast|normal|slow>      Search tier (per-provider mapping):
                                   fast   = Tavily depth=fast   / Brave count=5
                                   normal = Tavily depth=basic  / Brave count=10 (default)
                                   slow   = Tavily depth=advanced / Brave count=20
                                   Parallel ignores (single mode).
  --no-fallback                  Stay on default provider, no cross-provider fallback
  --no-cache                     Skip response cache
  --json                         Print normalized envelope as JSON
  --raw-json                     Print raw provider response (bypasses cache)
  --confirm-expensive            Allow operations estimated > 10 credits
  --no-budget                    Disable the self-budget abort: let calls run
                                   to the provider's per-request ceiling instead
                                   of the detected harness bash timeout. Use ONLY
                                   on harnesses with NO bash timeout (e.g. Pi
                                   core). Same as SURF_NO_TIMEOUT=1.
  --quiet                        Silence progress logs (stderr)
  --help, -h                     Show this help
  --version, -v                  Show version

Progress logs (stderr):
  surf-research-skill emits one line per event to stderr, e.g.:
    [surf 17:58:12] ▸ search → tavily (key #0)
    [surf 17:58:14] ✓ search tavily 1234ms (2 credits)
  Format is stable for agent parsing. Use --quiet or SURF_QUIET=1 to silence.

Examples:
  surf-research-skill ai-setup
  surf-search-normal "does OpenRouter support strict json_schema output?" \\
    --task "adding structured LLM calls to a CLI" \\
    --goal "know which request fields to send and what breaks" \\
    --insights "I think response_format.json_schema.strict works on DeepSeek"
  surf-search-unlimit "best way to cap concurrency in Node without deps" --max-rounds 4
  surf-research-skill setup
  surf-research-skill search "claude 4.7 release notes" --max 3
  surf-research-skill search "topic A" "topic B" "topic C"      # batch (3 queries)
  surf-research-skill search-parallel "topic A" "topic B" "topic C" --concurrency 6
  surf-research-skill search-parallel --queries-file q.json --concurrency 8 --no-budget --json
  surf-research-skill extract https://docs.anthropic.com/...
  surf-research-skill research-start "compare X and Y" --model pro --confirm-expensive
  surf-research-skill keys add --provider tavily tvly-AAA tvly-BBB tvly-CCC   # many at once
  cat keys.txt | surf-research-skill keys add --provider tavily --stdin       # one key per line
  surf-research-skill keys list

Need free, no-key search? Use the separate surf-free-skill (Wikipedia +
DuckDuckGo). surf-research-skill itself requires an API key.
Key & state are stored in ~/.config/surf/keys.json (chmod 600).
Docs: ~/.agents/skills/surf-research-agent-skill/SKILL.md`;

function die(msg, code = 1) {
  process.stderr.write(`❌ Error: ${msg}\n`);
  process.exit(code);
}

function out(msg) {
  if (msg == null) return;
  const s = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
}

function emitResult(envelope, flags) {
  if (flags['raw-json']) {
    out(JSON.stringify(envelope.raw, null, 2));
    return;
  }
  if (flags.json) {
    out(JSON.stringify({
      provider: envelope.provider,
      operation: envelope.operation,
      latency_ms: envelope.latency_ms,
      usage: envelope.usage,
      data: envelope.data,
    }, null, 2));
    return;
  }
  out(formatFor(envelope));
}

function buildSearchArgs(query, flags) {
  // --mode is the canonical flag. --depth (Tavily-ism) is still accepted as
  // legacy alias; if neither is set, default to depth='advanced' (Tavily) which
  // also resolves to mode='slow' on Brave.
  return {
    query,
    mode: flags.mode,
    depth: flags.depth || (flags.mode ? undefined : 'advanced'),
    max: flags.max,
    topic: flags.topic,
    time: flags.time,
    startDate: flags['start-date'],
    endDate: flags['end-date'],
    domains: flags.domains,
    excludeDomains: flags.exclude,
    country: flags.country,
    answer: flags.answer,
    raw: flags.raw,
    images: flags.images,
    imageDesc: flags['image-desc'],
    favicon: flags.favicon,
    auto: flags.auto,
    exactMatch: flags['exact-match'],
    processor: flags.processor,
  };
}

async function cmdSearch(pos, flags) {
  if (!pos.length) die('Usage: surf-research-skill search "query" [more queries ...]');

  // Backward-compat: 1 positional arg = exactly one query (same as before).
  if (pos.length === 1) {
    const args = buildSearchArgs(pos[0], flags);
    emitResult(await dispatch('search', args, flags), flags);
    return;
  }

  // Batch mode: each positional arg is an independent query.
  // Runs sequentially to avoid hammering one provider/key with N concurrent
  // calls (which would trigger 429 rate limits).
  await runSearchBatch(pos, flags);
}

async function runSearchBatch(queries, flags) {
  progress.start(`batch: ${queries.length} queries`);
  const batches = [];
  let okCount = 0;
  let failCount = 0;
  let totalCredits = 0;
  const t0 = Date.now();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const label = `[${i + 1}/${queries.length}] "${q}"`;
    progress.start(label);
    const args = buildSearchArgs(q, flags);
    try {
      const env = await dispatch('search', args, flags);
      okCount++;
      const credits = env.usage && env.usage.credits;
      if (credits != null) totalCredits += credits;
      batches.push({
        index: i,
        query: q,
        ok: true,
        provider: env.provider,
        latency_ms: env.latency_ms,
        usage: env.usage,
        data: env.data,
        raw: env.raw,
      });
    } catch (e) {
      failCount++;
      const code = e.code || e.name || 'Error';
      progress.fail(`${label} failed: [${code}] ${e.message || e}`);
      batches.push({
        index: i,
        query: q,
        ok: false,
        error: { code, message: e.message || String(e), details: e.details },
      });
    }
  }

  const elapsed = Date.now() - t0;
  progress.done(`batch done: ${okCount}/${queries.length} ok, ${failCount} failed (${elapsed}ms, ${totalCredits} credits)`);

  emitBatchResult({
    operation: 'search-batch',
    summary: { total: queries.length, succeeded: okCount, failed: failCount, total_credits: totalCredits, latency_ms: elapsed },
    batches,
  }, flags);

  // Exit non-zero only when EVERY query failed.
  if (okCount === 0 && failCount > 0) process.exitCode = 1;
}

function emitBatchResult(payload, flags) {
  if (flags['raw-json']) {
    out(JSON.stringify(payload.batches.map(b => b.raw ?? b.error), null, 2));
    return;
  }
  if (flags.json) {
    // Strip `raw` from JSON output unless explicitly asked.
    const safe = {
      operation: payload.operation,
      summary: payload.summary,
      data: { batches: payload.batches.map(({ raw, ...rest }) => rest) },
    };
    out(JSON.stringify(safe, null, 2));
    return;
  }
  // Markdown
  const { summary, batches } = payload;
  let md = `# Search batch (${summary.total} queries · ${summary.succeeded} ok · ${summary.failed} failed)\n\n`;
  md += `_total: ${summary.total_credits} credits · ${summary.latency_ms}ms_\n\n`;
  for (const b of batches) {
    md += `---\n\n## [${b.index + 1}/${summary.total}] ${b.query}\n\n`;
    if (!b.ok) {
      md += `**❌ Failed:** \`[${b.error.code}]\` ${b.error.message}\n\n`;
      continue;
    }
    md += `_provider: ${b.provider} · ${b.latency_ms}ms`;
    if (b.usage && b.usage.credits != null) md += ` · ${b.usage.credits} credits`;
    md += `_\n\n`;
    const r = b.data;
    if (r.answer) md += `**Answer:** ${r.answer}\n\n`;
    (r.results || []).forEach((it, i) => {
      md += `### [${i + 1}] ${it.title || it.url}\n${it.url}\n`;
      if (it.score != null) md += `*score: ${typeof it.score === 'number' ? it.score.toFixed(2) : it.score}*\n`;
      if (it.published_date) md += `*published: ${it.published_date}*\n`;
      const content = it.content || '';
      md += `\n${content.length > 1500 ? content.slice(0, 1500) + '…' : content}\n\n`;
    });
  }
  out(md);
}

// --- Parallel search (fan-out) ---

// Read a JSON array (preferred) or newline-delimited list from a file.
// Returns the parsed array; throws via die() on read/parse problems.
async function readListFile(file, label) {
  let txt;
  try { txt = await readFile(file, 'utf8'); }
  catch (e) { die(`${label}: cannot read ${file}: ${e.message}`); }
  try {
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed)) die(`${label}: ${file} must contain a JSON array.`);
    return parsed;
  } catch (e) {
    if (e && e.message && /must contain a JSON array/.test(e.message)) throw e;
    // Not JSON — treat as newline-delimited.
    return txt.split('\n').map(s => s.trim()).filter(Boolean);
  }
}

async function readUrlsFile(file) {
  const parsed = await readListFile(file, '--urls-file');
  const urls = [];
  for (const el of parsed) {
    if (typeof el === 'string') urls.push(el.trim());
    else if (el && typeof el === 'object' && (el.url || el.href)) urls.push(String(el.url || el.href));
  }
  return urls.filter(Boolean);
}

// Build the query work-list from positional args + an optional --queries-file.
// Each item is { id, q, sub } so output can be grouped by sub-question.
async function collectParallelQueries(pos, flags) {
  const items = pos.map((q, i) => ({ id: `q${i + 1}`, q, sub: null }));
  if (flags['queries-file']) {
    const parsed = await readListFile(flags['queries-file'], '--queries-file');
    parsed.forEach((el, i) => {
      if (typeof el === 'string') {
        items.push({ id: `f${i + 1}`, q: el, sub: null });
      } else if (el && typeof el === 'object' && (el.q || el.query)) {
        items.push({
          id: el.id || `f${i + 1}`,
          q: el.q || el.query,
          sub: el.sub || el.subQuestion || el.sub_question || null,
        });
      }
    });
  }
  return items.filter(it => typeof it.q === 'string' && it.q.trim());
}

function resolveConcurrency(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 6; // default
  return clamp(Math.floor(n), 1, 16);
}

async function cmdSearchParallel(pos, flags) {
  const items = await collectParallelQueries(pos, flags);
  if (!items.length) {
    die('Usage: surf-research-skill search-parallel "q1" "q2" ... [--queries-file F.json] [--concurrency 6] [--no-budget]');
  }
  const concurrency = resolveConcurrency(flags.concurrency);

  // Load shared state ONCE and suppress per-call persistence: concurrent
  // dispatches mutate this one object (single-threaded JS → no torn writes),
  // burned keys become visible to in-flight workers immediately, and we avoid
  // lockfile thrash. State is persisted once after the pool drains.
  const state = await loadState();
  state._inMemory = true;

  progress.start(
    `parallel: ${items.length} queries · concurrency ${concurrency}` +
    (flags['no-budget'] ? ' · no-budget' : '')
  );
  const t0 = Date.now();

  const settled = await mapPool(items, concurrency, (item) =>
    dispatch('search', buildSearchArgs(item.q, flags), flags, { state })
  );

  // Persist accumulated burned/last_ok once (best-effort; normalize drops _inMemory).
  try { delete state._inMemory; await saveStateAtomic(state); } catch {}

  let okCount = 0;
  let failCount = 0;
  let totalCredits = 0;
  const results = items.map((item, i) => {
    const r = settled[i];
    if (r && r.ok) {
      okCount++;
      const env = r.value;
      const credits = env.usage && env.usage.credits;
      if (credits != null) totalCredits += credits;
      return {
        index: i, id: item.id, sub: item.sub, query: item.q, ok: true,
        provider: env.provider, latency_ms: env.latency_ms, usage: env.usage,
        data: env.data, raw: env.raw,
      };
    }
    failCount++;
    const e = (r && r.error) || new Error('unknown error');
    const code = e.code || e.name || 'Error';
    progress.fail(`[${item.id}] "${item.q}" failed: [${code}] ${e.message || e}`);
    return {
      index: i, id: item.id, sub: item.sub, query: item.q, ok: false,
      error: { code, message: e.message || String(e), details: e.details },
    };
  });

  const elapsed = Date.now() - t0;
  progress.done(`parallel done: ${okCount}/${items.length} ok, ${failCount} failed (${elapsed}ms, ${totalCredits} credits)`);

  emitParallelResult({
    operation: 'search-parallel',
    summary: { total: items.length, succeeded: okCount, failed: failCount, total_credits: totalCredits, latency_ms: elapsed, concurrency },
    results,
  }, flags);

  // Exit non-zero only when EVERY query failed.
  if (okCount === 0 && failCount > 0) process.exitCode = 1;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function emitParallelResult(payload, flags) {
  if (flags['raw-json']) {
    out(JSON.stringify(payload.results.map(r => r.raw ?? r.error), null, 2));
    return;
  }
  if (flags.json) {
    out(JSON.stringify({
      operation: payload.operation,
      summary: payload.summary,
      data: { results: payload.results.map(({ raw, ...rest }) => rest) },
    }, null, 2));
    return;
  }
  // Markdown — group by sub-question when any item carries one.
  const { summary, results } = payload;
  let md = `# Parallel search (${summary.total} queries · ${summary.succeeded} ok · ${summary.failed} failed · c=${summary.concurrency})\n\n`;
  md += `_total: ${summary.total_credits} credits · ${summary.latency_ms}ms_\n\n`;
  const hasSubs = results.some(r => r.sub);
  const groups = hasSubs ? groupBy(results, r => r.sub || '(ungrouped)') : new Map([['', results]]);
  for (const [sub, rows] of groups) {
    if (sub) md += `## Sub-question: ${sub}\n\n`;
    for (const b of rows) {
      md += `---\n\n### [${b.id}] ${b.query}\n\n`;
      if (!b.ok) {
        md += `**❌ Failed:** \`[${b.error.code}]\` ${b.error.message}\n\n`;
        continue;
      }
      md += `_provider: ${b.provider} · ${b.latency_ms}ms`;
      if (b.usage && b.usage.credits != null) md += ` · ${b.usage.credits} credits`;
      md += `_\n\n`;
      const r = b.data || {};
      if (r.answer) md += `**Answer:** ${r.answer}\n\n`;
      (r.results || []).forEach((it, i) => {
        md += `#### [${i + 1}] ${it.title || it.url}\n${it.url}\n`;
        if (it.score != null) md += `*score: ${typeof it.score === 'number' ? it.score.toFixed(2) : it.score}*\n`;
        if (it.published_date) md += `*published: ${it.published_date}*\n`;
        const content = it.content || '';
        md += `\n${content.length > 1200 ? content.slice(0, 1200) + '…' : content}\n\n`;
      });
    }
  }
  out(md);
}

async function cmdExtract(pos, flags) {
  const urls = [...pos];
  if (flags['urls-file']) {
    urls.push(...await readUrlsFile(flags['urls-file']));
  }
  if (!urls.length) die('Usage: surf-research-skill extract <url1> [url2 ...] | --urls-file F.json');
  if (urls.length > 20) die(`extract supports at most 20 URLs per call (got ${urls.length}). Split into batches.`);
  const args = {
    urls,
    depth: flags.depth || 'basic',
    format: flags.format || 'markdown',
    images: flags.images,
    favicon: flags.favicon,
    query: flags.query,
    chunks: flags.chunks,
    extractTimeout: flags['extract-timeout'],
  };
  emitResult(await dispatch('extract', args, flags), flags);
}

async function cmdCrawl(pos, flags) {
  const url = pos[0];
  if (!url) die('Usage: surf-research-skill crawl <url> [flags]');
  const args = {
    url,
    maxDepth: flags['max-depth'],
    maxBreadth: flags['max-breadth'],
    limit: flags.limit,
    instructions: flags.instructions,
    selectPaths: flags['select-paths'],
    selectDomains: flags['select-domains'],
    excludePaths: flags['exclude-paths'],
    excludeDomains: flags['exclude-domains'],
    allowExternal: flags['allow-external'],
    images: flags.images,
    categories: flags.categories,
    extractDepth: flags['extract-depth'] || 'basic',
    format: flags.format || 'markdown',
    query: flags.query,
    chunks: flags.chunks,
    timeout: flags.timeout,
  };
  emitResult(await dispatch('crawl', args, flags), flags);
}

async function cmdMap(pos, flags) {
  const url = pos[0];
  if (!url) die('Usage: surf-research-skill map <url> [flags]');
  const args = {
    url,
    maxDepth: flags['max-depth'],
    maxBreadth: flags['max-breadth'],
    limit: flags.limit,
    instructions: flags.instructions,
    selectPaths: flags['select-paths'],
    selectDomains: flags['select-domains'],
    excludePaths: flags['exclude-paths'],
    excludeDomains: flags['exclude-domains'],
    allowExternal: flags['allow-external'],
    categories: flags.categories,
    timeout: flags.timeout,
  };
  emitResult(await dispatch('map', args, flags), flags);
}

async function cmdResearchStart(pos, flags) {
  const input = pos.join(' ').trim();
  if (!input) die('Usage: surf-research-skill research-start "topic" [--model mini|auto|pro]');
  const args = {
    input,
    model: flags.model || 'auto',
    citationFormat: flags.citations || 'numbered',
    outputSchema: flags.schema ? JSON.parse(await readFile(flags.schema, 'utf8')) : undefined,
    processor: flags.processor,
  };
  const envelope = await dispatch('research-start', args, flags);
  await persistResearchHandle(envelope);
  emitResult(envelope, flags);
}

async function cmdResearchPoll(pos, flags) {
  const id = pos[0];
  if (!id) die('Usage: surf-research-skill research-poll <request_id>');
  const decoded = providerFromRequestId(id);
  if (!decoded) die(`unknown request_id prefix in '${id}' (expected tvly:... or pllx:...)`);
  const envelope = await dispatch('research-poll', {}, { ...flags, __requestId: id });
  if (envelope.data.status === 'completed' || envelope.data.status === 'failed') {
    try { await unlink(`/tmp/surf-${id.replace(':', '_')}.json`); } catch {}
  }
  emitResult(envelope, flags);
}

async function cmdResearch(pos, flags) {
  const input = pos.join(' ').trim();
  if (!input) die('Usage: surf-research-skill research "topic"');
  const model = flags.model || 'mini';
  if (model === 'pro' || model === 'ultra') {
    die(`Refusing sync research with model=${model} (would exceed timeout). Use 'surf-research-skill research-start' + 'surf-research-skill research-poll'.`);
  }
  const startArgs = {
    input,
    model,
    citationFormat: flags.citations || 'numbered',
    processor: flags.processor,
  };
  const start = await dispatch('research-start', startArgs, flags);
  await persistResearchHandle(start);
  const id = start.data.request_id;
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const poll = await dispatch('research-poll', {}, { ...flags, __requestId: id });
    if (poll.data.status === 'completed' || poll.data.status === 'failed') {
      try { await unlink(`/tmp/surf-${id.replace(':', '_')}.json`); } catch {}
      emitResult(poll, flags);
      return;
    }
  }
  out(`**Research did not finish in 50s.** Continue with: \`surf-research-skill research-poll ${id}\``);
}

async function persistResearchHandle(envelope) {
  try {
    const id = envelope.data.request_id;
    await mkdir('/tmp', { recursive: true }).catch(() => {});
    await writeFile(`/tmp/surf-${id.replace(':', '_')}.json`, JSON.stringify({
      started: Date.now(),
      provider: envelope.provider,
      request_id: id,
    }));
  } catch {}
}

// --- surf-ai (autonomous research loop) ---
// Implementation lives in src/lib/ai/cli.mjs so the two standalone bins
// (surf-search-normal / surf-search-unlimit) share it byte for byte.

async function cmdAi(pos, flags, forcedMode) {
  const code = await runAiCommand({ pos, flags, mode: forcedMode });
  if (code) process.exitCode = code;
}

async function cmdUsage(_pos, flags) {
  if (!flags.provider) die(`Usage: surf-research-skill usage --provider <tavily|parallel>`);
  emitResult(await dispatch('usage', {}, flags), flags);
}

async function cmdCacheClear() {
  const n = await cacheClear();
  out(`Cleared ${n} cache entr${n === 1 ? 'y' : 'ies'}.`);
}

async function cmdCost(_pos, flags) {
  if (flags.reset) {
    try { await unlink(USAGE_LOG); } catch {}
    out('Reset local usage ledger.');
    return;
  }
  const entries = await readUsage();
  const total = entries.reduce((s, e) => s + (Number(e.credits) || 0), 0);
  const live = entries.filter(e => !e.cached);
  const hits = entries.filter(e => e.cached).length;
  const byProvider = {};
  for (const e of entries) {
    const p = e.provider || 'unknown';
    byProvider[p] = (byProvider[p] || 0) + (Number(e.credits) || 0);
  }
  if (flags.json) {
    out(JSON.stringify({
      totalCredits: total, byProvider,
      entries: entries.length, liveCalls: live.length, cacheHits: hits,
      recent: entries.slice(-20),
    }, null, 2));
    return;
  }
  let md = `**Local recorded credits:** ${total}\n`;
  for (const p of Object.keys(byProvider)) md += `- ${p}: ${byProvider[p]}\n`;
  md += `\n- live API calls: ${live.length}\n- cache hits: ${hits}\n`;
  if (!entries.length) {
    md += '\n_No local usage recorded yet._\n';
  } else {
    md += '\n**Recent calls**\n';
    for (const e of entries.slice(-20)) {
      md += `- ${e.ts} [${e.provider || '?'}] ${e.op}: ${e.credits ?? '—'}${e.cached ? ' (cache hit)' : ''}\n`;
    }
  }
  md += '\nUse `surf-research-skill cost --reset` to clear the local ledger.';
  out(md);
}

async function cmdKeys(pos, flags) {
  const sub = pos[0];
  if (!sub) die('Usage: surf-research-skill keys <add|remove|list|reset|clear> ...');
  const subPos = pos.slice(1);
  try {
    const result = await runKeysSubcommand(sub, subPos, flags);
    if (sub === 'list' || sub === 'ls' || sub === 'status') {
      if (result.json) out(JSON.stringify(result.state, null, 2));
      else out(result.text);
      return;
    }
    if (flags.json) {
      out(JSON.stringify(result, null, 2));
    } else if (sub === 'add') {
      for (const r of result.results) {
        if (r.added) {
          const v = r.validation ? ` (validated, ${r.validation.latency_ms}ms, ${r.validation.credits} credit${r.validation.credits === 1 ? '' : 's'})` : '';
          out(`✓ added [${r.index}] ${maskKey(r.key)} to ${result.provider}${v}`);
        } else if (r.reason === 'already exists') {
          out(`• ${maskKey(r.key)} already exists in ${result.provider} (no-op)`);
        } else {
          out(`✗ ${maskKey(r.key)} NOT saved — ${r.reason}`);
        }
      }
      out(`\n${result.addedCount}/${result.attempted} key(s) added to ${result.provider}.`);
      // Non-zero exit only when nothing was added AND a real failure occurred
      // (not merely "already exists"), so `keys add` surfaces errors in scripts.
      if (result.addedCount === 0 && result.results.some(r => !r.added && r.reason !== 'already exists')) {
        out(`Re-run with --skip-validate to add unvalidated keys.`);
        process.exitCode = 1;
      }
    } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      out(`✓ removed index ${result.index} from ${result.provider}`);
    } else if (sub === 'reset') {
      out(`✓ cleared burned for ${result.provider || 'all providers'}`);
    } else if (sub === 'clear') {
      out(`✓ cleared all keys${flags.all ? '' : ' for ' + (flags.provider || '?')}`);
    }
  } catch (e) {
    if (e.code === 'NEEDS_YES') {
      process.stderr.write(`❌ Error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

// --- Main ---

await migrateLegacy();

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  out(HELP); process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  out(VERSION); process.exit(0);
}

const { pos, flags } = parseFlags(rest);

// Wire --quiet before any progress event fires.
if (flags.quiet) setSilent(true);

// Auto-launch setup wizard on first TTY use when no keys are configured.
// Commands that don't need keys (setup, keys, project-config, help, etc.)
// are excluded.
// surf-ai commands are excluded too: they degrade to the keyless tier on their
// own, so hijacking the run with a wizard would be wrong.
const NO_KEYS_NEEDED = new Set([
  'setup', 'keys', 'project-config',
  'cache-clear', 'cost',
  'ai', 'ai-setup', 'surf-search-normal', 'surf-search-unlimit',
  '--help', '-h', '--version', '-v',
]);
if (!NO_KEYS_NEEDED.has(cmd) && process.stdin.isTTY) {
  try {
    const { loadState, SEARCH_PROVIDERS } = await import('../src/lib/state.mjs');
    const state = await loadState();
    const hasAny = SEARCH_PROVIDERS.some(p => ((state[p] && state[p].keys) || []).length);
    if (!hasAny) {
      process.stderr.write('No keys configured. Launching setup wizard…\n\n');
      await runSetup();
      process.stderr.write('\n— Resuming your command —\n\n');
    }
  } catch {
    // If anything goes wrong with the auto-wizard, fall through to the
    // normal command which will produce its own actionable error.
  }
}

try {
  switch (cmd) {
    // surf-ai — the CLI owns the whole research loop.
    case 'ai': await cmdAi(pos, flags); break;
    case 'surf-search-normal': await cmdAi(pos, flags, 'normal'); break;
    case 'surf-search-unlimit':
    case 'surf-search-unlimited': await cmdAi(pos, flags, 'unlimit'); break;
    case 'ai-setup': await runAiSetup(flags); break;

    case 'search': await cmdSearch(pos, flags); break;
    case 'search-parallel': await cmdSearchParallel(pos, flags); break;
    case 'extract': await cmdExtract(pos, flags); break;
    case 'crawl': await cmdCrawl(pos, flags); break;
    case 'map': await cmdMap(pos, flags); break;
    case 'research': await cmdResearch(pos, flags); break;
    case 'research-start': await cmdResearchStart(pos, flags); break;
    case 'research-poll': await cmdResearchPoll(pos, flags); break;
    case 'usage': await cmdUsage(pos, flags); break;
    case 'cache-clear': await cmdCacheClear(); break;
    case 'cost': await cmdCost(pos, flags); break;
    case 'keys': await cmdKeys(pos, flags); break;
    case 'setup': await runSetup(); break;
    case 'project-config': {
      const result = await runProjectConfig(pos, flags);
      out(formatProjectConfigResult(result, { json: !!flags.json }));
      break;
    }
    default:
      die(`Unknown command: ${cmd}. Try 'surf-research-skill --help'.`);
  }
} catch (e) {
  if (e instanceof DispatchError) {
    process.stderr.write(`❌ Error [${e.code}]: ${e.message}\n`);
    if (e.code === 'NoProviderAvailable' && process.stdin.isTTY) {
      process.stderr.write(`→ Run 'surf-research-skill setup' to configure keys interactively.\n`);
    }
    process.exit(1);
  }
  if (e.code === 'AI_CLI_USAGE') {
    process.stderr.write(`❌ Error: ${e.message}\n`);
    process.exit(2);
  }
  if (e.code === 'PROJECT_CONFIG_NO_TTY' || e.code === 'PROJECT_CONFIG_BAD_HARNESS') {
    process.stderr.write(`❌ Error: ${e.message}\n`);
    process.exit(2);
  }
  if (e.code === 'NO_TTY') {
    process.stderr.write(`❌ Error: ${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`❌ Error: ${e.message || String(e)}\n`);
  process.exit(1);
}
