#!/usr/bin/env node
// surf-research-skill — the Brave Search CLI.
//
// One backend, one operation: `search` (plus `search-parallel`, which is the
// same operation fanned out). Key rotation and rate pacing live in
// src/lib/dispatch.mjs; the "is there a valid Brave key" gate lives in
// src/lib/preflight.mjs and runs before any command that would touch the API.

import { readFile, unlink } from 'node:fs/promises';
import { parseFlags, assertEnum, numericFlag, maskKey } from '../src/lib/flags.mjs';
import { dispatch, DispatchError } from '../src/lib/dispatch.mjs';
import { mapPool } from '../src/lib/pool.mjs';
import { formatFor } from '../src/lib/format.mjs';
import { runKeysSubcommand, maskState, redactState } from '../src/lib/keys-cmd.mjs';
import { cacheClear } from '../src/lib/cache.mjs';
import { readUsage, USAGE_LOG } from '../src/lib/audit.mjs';
import { migrateLegacy, loadState, saveStateAtomic, KEYS_FILE } from '../src/lib/state.mjs';
import { runSetup } from '../src/lib/setup.mjs';
import { runProjectConfig, formatProjectConfigResult } from '../src/lib/project-config.mjs';
import { MODES as SEARCH_MODES } from '../src/lib/providers/brave.mjs';
import {
  GateError, EXIT_CONFIG, assertProviderReady, resolveGate, formatGate, GATE,
} from '../src/lib/preflight.mjs';
import { DEFAULT_SUB_AGENTS, MAX_SUB_AGENTS } from '../src/lib/ai/orchestrator.mjs';
import { progress, setSilent } from '../src/lib/progress.mjs';
import { runAiCommand } from '../src/lib/ai/cli.mjs';
import { runAiSetup } from '../src/lib/ai/setup.mjs';

const VERSION = '8.0.1';

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

const HELP = `surf-research-skill — autonomous web research on Brave Search

Brave is the ONLY backend. Every command below either answers from Brave or
tells you exactly why it cannot. There is no fallback provider and no free
tier underneath: a missing or invalid Brave key exits 78 before anything runs.

surf-ai (autonomous research — the CLI runs the whole loop):
  surf-search-normal <question>    ONE wave: an LLM plans the queries, up to
                                   --sub-agents of them run at once, and the
                                   LLM writes the cited answer. Fitted inside
                                   the agent's bash timeout.
  surf-search-unlimit <question>   As many waves as the question needs. After
                                   each wave the analyst says what is still
                                   open, which branches are finished, and the
                                   frontier descends into the thin ones.
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

  Fan-out and depth:
    --sub-agents N          simultaneous searches per wave (default ${DEFAULT_SUB_AGENTS}, max ${MAX_SUB_AGENTS}).
                            Also accepted as --sub-agents=N. This is the ONE
                            simultaneity budget: it is both the wave width and
                            the worker-pool width, so the two can never
                            multiply into a burst your Brave plan cannot serve.
                            surf reads your plan's real requests-per-second
                            from Brave's own response headers and paces the
                            wave to it — asking for more than the plan allows
                            queues rather than fails, and surf says so.
    --concurrency N         deprecated alias for --sub-agents.
    --max-depth N           how far a branch may descend (default 2 normal /
                            3 unlimit, max 6). Depth 0 is the plan's own
                            queries; a depth-2 query exists because a depth-1
                            result raised it.
    --max-rounds N          wave cap, unlimit only (default 6, hard cap 50)
    --max-queries N         frontier admissions per wave (>= --sub-agents)
    --search-mode <fast|normal|slow>   results per query: 5 / 10 / 20
    --budget-ms N           override the self-budget (0 = unlimited)
    --ledger                append the coverage table + the rejected frontier

Commands:
  gate [--json]               Is there a usable Brave key? Exit 0 = yes,
                              exit 78 = no. THIS is the FASE-0 probe: it is the
                              only verb that both answers without a key and
                              reports the answer in its exit code. ('keys list'
                              also runs without a key, but it is a report and
                              always exits 0.) --json prints a masked
                              diagnostic; no key material ever reaches stdout.
  setup                       Interactive onboarding wizard (TTY required)
  project-config [--harness <copilot|claude|pi|all>] [--yes]
                              Write per-project bash-timeout config so the
                              harness used in this project doesn't kill us.
                              REQUIRED for GH Copilot CLI projects.
  search <q> [<q2> ...]       Web search. Multiple positional args = batch
                              (sequential, partial failures reported inline).
  search-parallel <q> [q2...] Fan out MANY searches at once, paced to your
                              [--queries-file F.json] [--sub-agents N]
                              Brave plan's rate limit. Accepts positional
                              queries and/or a JSON queries file
                              ([ "q", {"q":"...","id":"...","sub":"..."} ]).
  cache-clear                 Purge response cache
  cost [--reset]              Local request ledger
  keys <add|remove|list|reset|clear> [...]
                              EVERY 'keys ... --json' payload is MASKED — add,
                              remove, list and reset alike. Pass
                              --unsafe-show-keys only if a script genuinely
                              needs the raw value — agent stdout ends up in
                              transcripts and handoff files.
                              'keys remove <index|key>' matches BY VALUE first
                              and falls back to the index only when no key
                              equals the argument.

Search flags (all of these now actually reach Brave — several used to be
accepted and silently discarded):
  --mode <fast|normal|slow>   Results per query: 5 / 10 / 20. Default normal.
  --max N                     Explicit result count, 1-20. Overrides --mode.
  --offset N                  Page index, 0-9. Brave caps pagination there;
                              beyond ~120 results the well runs dry, so depth
                              comes from asking different questions instead.
  --time <day|week|month|year>        → Brave freshness (pd/pw/pm/py)
  --start-date / --end-date YYYY-MM-DD → freshness date range (beats --time)
  --domains a.com,b.com       Restrict to these sites (OR-grouped site: ops)
  --exclude c.com             Exclude a site (-site:)
  --country XX · --search-lang · --ui-lang · --safesearch <off|moderate|strict>
  --goggles <url>             Brave Goggles re-ranking
  --result-filter <list>      web,news,discussions,faq,…
  --json / --raw-json / --no-cache / --quiet / --confirm-expensive
  --no-budget                 Disable the self-budget abort. Use ONLY on a
                              harness with NO bash timeout (e.g. Pi core).

REMOVED IN v8 (Brave has no equivalent on the Search plan):
  extract · crawl · map · research · research-start · research-poll · usage
  Brave's /web/search returns ranked links and snippets, never page content.
  Use \`search\` and follow the URLs with your own reader. (Brave does ship an
  /llm/context endpoint that returns extracted text, but it is plan-gated —
  a key without it answers HTTP 400 OPTION_NOT_IN_PLAN.)

Exit codes:
  0   the command worked
  1   the operation ran and failed (searches failed, nothing retrieved)
  2   you typed the command wrong (usage / bad flag value)
  78  configuration is broken — no valid Brave key. Retrying will not help.

Progress logs (stderr):
    [surf 17:58:12] ▸ search → brave (key #0)
    [surf 17:58:14] ✓ search brave 1234ms (1 credits)
  Format is stable for agent parsing. Use --quiet or SURF_QUIET=1 to silence.

Examples:
  surf-research-skill ai-setup
  surf-search-normal "does OpenRouter support strict json_schema output?" \\
    --task "adding structured LLM calls to a CLI" \\
    --goal "know which request fields to send and what breaks" \\
    --insights "I think response_format.json_schema.strict works on DeepSeek"
  surf-search-unlimit "how do teams cap LLM spend in CI" --sub-agents=10 --max-depth 3
  surf-research-skill search "claude 4.7 release notes" --max 3
  surf-research-skill search "postgres HNSW limits" --domains postgresql.org --time year
  surf-research-skill search-parallel "topic A" "topic B" --sub-agents=6
  surf-research-skill keys add --provider brave BSA-AAA BSA-BBB   # many at once
  surf-research-skill keys list

  surf-research-skill gate || echo "no usable Brave key (exit 78)"

Keys & state:   ~/.config/surf/keys.json (chmod 600)
Brave API docs: references/brave-api.md · https://api-dashboard.search.brave.com
Skill docs:     ~/.agents/skills/surf-research-agent-skill/SKILL.md`;

// The exit-code contract, printed by --help and relied on by orchestrating
// agents to decide whether to FIX the command or to carry on without the data:
//   1  the operation ran and failed   → retrying may work
//   2  you typed the command wrong    → retrying the same thing cannot work
//   78 configuration is broken        → no valid Brave key; fix the config
//
// die() is for (1). usage() is for (2). Almost everything below is (2): a
// missing argument, an unreadable file, an unknown verb. They used to all
// exit 1, which told an agent to retry a command that can never succeed.
function die(msg, code = 1) {
  process.stderr.write(`❌ Error: ${msg}\n`);
  process.exit(code);
}

function usage(msg) {
  die(msg, 2);
}

/**
 * The single exit for every error this bin can produce. One function, so the
 * flag-parsing path and the command path cannot disagree about what an error
 * costs — and so nothing ever reaches Node's default handler, which prints a
 * stack trace full of absolute paths and exits 1.
 *
 * Never returns.
 */
function reportFatal(e) {
  const codes2 = new Set([
    'FLAG_USAGE',            // src/lib/flags.mjs — a flag you typed wrong
    'AI_CLI_USAGE',          // src/lib/ai/cli.mjs
    'PROJECT_CONFIG_NO_TTY',
    'PROJECT_CONFIG_BAD_HARNESS',
    'NO_TTY',
    'NEEDS_YES',
  ]);
  if (e instanceof GateError) {
    process.stderr.write(e.message + '\n');
    process.exit(EXIT_CONFIG);
  }
  if (e instanceof DispatchError) {
    process.stderr.write(`❌ Error [${e.code}]: ${e.message}\n`);
    if (e.code === 'NoProviderAvailable' && process.stdin.isTTY) {
      process.stderr.write(`→ Run 'surf-research-skill setup' to configure keys interactively.\n`);
    }
    process.exit(1);
  }
  if (e && codes2.has(e.code)) {
    process.stderr.write(`❌ Error: ${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`❌ Error: ${(e && e.message) || String(e)}\n`);
  process.exit(1);
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
  // Every one of these used to be raw passthrough. A typo in any of them made
  // Brave answer 422, which the old adapter read as "bad key" and used to burn
  // the entire key ring. Validate here, once, for both the single and the
  // batch/parallel paths.
  assertEnum('--mode', flags.mode, SEARCH_MODES);
  assertEnum('--depth', flags.depth, ['basic', 'advanced', 'fast', 'ultra-fast']);
  assertEnum('--topic', flags.topic, ['general', 'news']);
  assertEnum('--time', flags.time, ['day', 'week', 'month', 'year']);
  assertEnum('--safesearch', flags.safesearch, ['off', 'moderate', 'strict']);
  if (flags.mode && flags.depth) {
    usage(`--mode and --depth mean the same thing; pass only one (--depth is the deprecated spelling).`);
  }
  if (flags.country && !/^[A-Za-z]{2}$/.test(String(flags.country))) {
    usage(`--country must be a 2-letter code (got '${flags.country}')`);
  }

  // NOTE: no implicit default is injected. The old code substituted
  // depth:'advanced' whenever --mode was absent, which silently ran every
  // search at the widest tier while --help promised 'normal'.
  return {
    query,
    mode: flags.mode,
    depth: flags.depth,
    max: flags.max,
    offset: flags.offset,
    topic: flags.topic,
    time: flags.time,
    startDate: flags['start-date'],
    endDate: flags['end-date'],
    freshness: flags.freshness,
    domains: flags.domains,
    excludeDomains: flags.exclude,
    country: flags.country,
    searchLang: flags['search-lang'],
    uiLang: flags['ui-lang'],
    safesearch: flags.safesearch,
    resultFilter: flags['result-filter'],
    goggles: flags.goggles,
  };
}

async function cmdSearch(pos, flags) {
  if (!pos.length) usage('Usage: surf-research-skill search "query" [more queries ...]');

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
      const when = it.published_date || it.age_text;
      if (when) md += `*published: ${when}*\n`;
      const content = it.content || '';
      md += `\n${content.length > 1500 ? content.slice(0, 1500) + '…' : content}\n\n`;
    });
  }
  out(md);
}

// --- Parallel search (fan-out) ---

// Read a JSON array (preferred) or a newline-delimited list from a file.
// Every failure is a USAGE error (exit 2): the file is input the caller typed,
// and no amount of retrying fixes a missing bracket.
//
// WHY THIS IS A MONEY BUG, not a cosmetic one: the old version fell back to
// newline-splitting on ANY JSON parse error. A --queries-file with one missing
// bracket therefore became the query list
//     [ '[', '"alpha query",', '"beta query"' ]
// and surf sent all three to Brave as real, billable searches. Malformed input
// must cost zero requests, so a file that ANNOUNCES itself as JSON (first
// non-space character `[` or `{`) has to BE valid JSON or the command stops
// before dispatch is ever reached.
async function readListFile(file, label) {
  let txt;
  try { txt = await readFile(file, 'utf8'); }
  catch (e) { usage(`${label}: cannot read ${file}: ${e.message}`); }

  const trimmed = String(txt).trim();
  if (!trimmed) usage(`${label}: ${file} is empty.`);

  if (trimmed[0] === '[' || trimmed[0] === '{') {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      usage(
        `${label}: ${file} starts like JSON but does not parse (${e.message}). ` +
        `Fix the file — surf will NOT guess, because every guessed line would be a real, billable Brave search.`,
      );
    }
    if (!Array.isArray(parsed)) usage(`${label}: ${file} must contain a JSON array.`);
    return parsed;
  }

  // Not JSON — the documented newline-delimited form.
  const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean);
  // A file that got here still holding JSON fragments is broken JSON that lost
  // its outer brackets, not a list. Same reasoning: refuse, do not spend.
  //   `[` `]` `,`        — bare punctuation
  //   `"alpha query",`   — a quoted element with its separator still attached
  //   `{"q":"x"},`       — an object element likewise
  // A plain `"exact phrase"` line is NOT rejected: quoting a phrase is a real
  // way to write a query, and it has no trailing separator.
  const fragment = lines.find(l => /^[[\]{},]+$/.test(l) || /^["{].*,$/.test(l));
  if (fragment) {
    usage(
      `${label}: ${file} looks like broken JSON (a line is ${JSON.stringify(fragment)}), ` +
      `not a newline-delimited list. Fix the file — surf will not turn syntax into billable searches.`,
    );
  }
  return lines;
}

// Build the query work-list from positional args + an optional --queries-file.
// Each item is { id, q, sub } so output can be grouped by sub-question.
async function collectParallelQueries(pos, flags) {
  const items = pos.map((q, i) => ({ id: `q${i + 1}`, q, sub: null }));
  if (flags['queries-file']) {
    const parsed = await readListFile(flags['queries-file'], '--queries-file');
    const before = items.length;
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
    // A non-empty file that yielded nothing usable is a malformed file, not an
    // empty one. Say so instead of falling through to the generic "Usage:".
    if (parsed.length && items.length === before) {
      usage(
        `--queries-file: ${flags['queries-file']} has ${parsed.length} entr${parsed.length === 1 ? 'y' : 'ies'} ` +
        `but none is a query. Expected [ "text", {"q":"text","id":"…","sub":"…"} ].`,
      );
    }
  }
  return items.filter(it => typeof it.q === 'string' && it.q.trim());
}

/**
 * The one simultaneity budget, shared with the surf-ai path so the two fan-out
 * code paths cannot drift. --concurrency stays as a deprecated alias.
 */
function resolveSubAgents(flags) {
  const explicit = numericFlag(flags['sub-agents'], {
    name: '--sub-agents', min: 1, max: MAX_SUB_AGENTS, fallback: undefined,
  });
  if (explicit !== undefined) return explicit;
  const legacy = numericFlag(flags.concurrency, {
    name: '--concurrency', min: 1, max: MAX_SUB_AGENTS, fallback: undefined,
  });
  if (legacy !== undefined) {
    progress.warn(`--concurrency is deprecated; use --sub-agents=${legacy} (same meaning).`);
    return legacy;
  }
  return DEFAULT_SUB_AGENTS;
}

async function cmdSearchParallel(pos, flags) {
  const items = await collectParallelQueries(pos, flags);
  if (!items.length) {
    // KNOWN INCONSISTENCY (BUG#22): by the contract above this is a usage
    // error and should exit 2, exactly like `search` with no query. It stays 1
    // because test/adversarial/flags-cli.mjs pins it: its --queries-file
    // control asserts that `search-parallel --sub-agents 99` (an EMPTY query
    // list) exits 1, and uses that to tell "the file produced no queries"
    // apart from "a flag was rejected". Changing this to 2 turns that
    // assertion red; the suite is not ours to edit. Fix the assertion and the
    // second argument here together.
    die('Usage: surf-research-skill search-parallel "q1" "q2" ... [--queries-file F.json] [--sub-agents N] [--no-budget]');
  }
  const concurrency = resolveSubAgents(flags);

  // Load shared state ONCE and suppress per-call persistence: concurrent
  // dispatches mutate this one object (single-threaded JS → no torn writes),
  // burned keys become visible to in-flight workers immediately, and we avoid
  // lockfile thrash. State is persisted once after the pool drains.
  const state = await loadState();
  state._inMemory = true;

  progress.start(
    `parallel: ${items.length} queries · up to ${concurrency} at once` +
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
        const when = it.published_date || it.age_text;
        if (when) md += `*published: ${when}*\n`;
        const content = it.content || '';
        md += `\n${content.length > 1200 ? content.slice(0, 1200) + '…' : content}\n\n`;
      });
    }
  }
  out(md);
}

// --- surf-ai (autonomous research loop) ---
// Implementation lives in src/lib/ai/cli.mjs so the two standalone bins
// (surf-search-normal / surf-search-unlimit) share it byte for byte.

async function cmdAi(pos, flags, forcedMode) {
  const code = await runAiCommand({ pos, flags, mode: forcedMode });
  if (code) process.exitCode = code;
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

// --- gate (the FASE-0 probe) ---
//
// SKILL.md used to say "run `keys list` and check for exit 78". It never
// worked: `keys list` is in NO_KEYS_NEEDED (it has to be — a missing key is
// diagnosed by listing the keys) and it always exits 0, so the phase-0 branch
// was dead code. `keys list` cannot be the probe without breaking the one job
// it has, hence a verb whose ONLY output is the verdict:
//
//   exit 0  → a usable Brave key exists, searches can run
//   exit 78 → they cannot, and retrying will not help (sysexits EX_CONFIG)
async function cmdGate(_pos, flags) {
  const state = await loadState();
  const res = await resolveGate(state, 'brave');
  const ready = res.verdict === GATE.READY;
  const gate = ready ? null : formatGate(res.verdict, res.detail, 'brave');

  if (flags.json) {
    // Masked, like every other --json payload here. `detail` and `message`
    // quote provider-supplied text, which is not guaranteed to be free of the
    // token it is complaining about, so they are scrubbed too.
    const brave = maskState(state).brave || {};
    const payload = redactState({
      ok: ready,
      provider: 'brave',
      verdict: res.verdict,
      code: ready ? 'BraveKeyReady' : gate.code,
      detail: res.detail || null,
      key_index: Number.isInteger(res.index) && res.index >= 0 ? res.index : null,
      key_count: brave.key_count || 0,
      keys: brave.keys || [],
      keys_file: KEYS_FILE,
      exit_code: ready ? 0 : EXIT_CONFIG,
      message: ready ? null : gate.text,
    }, state);
    out(JSON.stringify(payload, null, 2));
  } else if (ready) {
    out(`✓ Brave gate OK — key #${res.index} is usable (${res.detail}).`);
  } else {
    process.stderr.write(gate.text + '\n');
  }

  // exitCode, not exit(): stdout must flush before the process ends.
  process.exitCode = ready ? 0 : EXIT_CONFIG;
}

async function cmdKeys(pos, flags) {
  const sub = pos[0];
  if (!sub) usage('Usage: surf-research-skill keys <add|remove|list|reset|clear> ...');
  const subPos = pos.slice(1);
  try {
    const result = await runKeysSubcommand(sub, subPos, flags);
    if (sub === 'list' || sub === 'ls' || sub === 'status') {
      if (result.json) out(JSON.stringify(result.state, null, 2));
      else out(result.text);
      return;
    }
    if (flags.json) {
      // Safe to print raw: keys-cmd.mjs masks EVERY value it returns (results
      // and state alike) unless --unsafe-show-keys was passed. This line used
      // to be the leak — add/remove/reset printed the unmasked result while
      // only `list` had been wired to the mask.
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
      out(`✓ removed index ${result.index} (${result.key}, matched by ${result.matched_by}) from ${result.provider}`);
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

// parseFlags runs at module top level, OUTSIDE the try/catch further down, so
// every FlagError it raised used to escape as an unhandled rejection: Node
// printed a raw stack trace with absolute file paths and exited 1. An agent
// reading stderr to decide what to do next got a stack trace where the
// documented contract promised "exit 2, you typed it wrong". Catch it here.
let pos, flags;
try {
  ({ pos, flags } = parseFlags(rest));
} catch (e) {
  reportFatal(e);
}

// Wire --quiet before any progress event fires.
if (flags.quiet) setSilent(true);

// Verbs that existed up to v7 and are gone. Recognised only so the error can
// say WHY, instead of "unknown command".
const REMOVED_VERBS = new Set([
  'extract', 'crawl', 'map', 'research', 'research-start', 'research-poll', 'usage',
]);

// THE GATE. Every command that will touch Brave proves a valid key first.
//
// This replaces a TTY-only auto-wizard that (a) never ran for the surf-ai
// commands, because those were expected to degrade to a keyless tier on their
// own, and (b) was satisfied by a Tavily key. Now: no valid Brave key, no run.
// In a terminal we still offer the wizard, because a human who can fix it
// right now should be allowed to.
//
// `gate` is exempt for the same reason `keys` is: it exists to answer the
// question WHEN THERE IS NO KEY. Running the gate before it would make it
// print the gate's own message and exit 78 without ever consulting --json, and
// on a TTY it would ambush the caller with the setup wizard.
const NO_KEYS_NEEDED = new Set([
  'setup', 'keys', 'project-config', 'gate',
  'cache-clear', 'cost', 'ai-setup',
  '--help', '-h', '--version', '-v',
]);
// Every verb the switch below understands, kept beside NO_KEYS_NEEDED so the
// two are edited together. A typo is caught HERE, before the gate: otherwise
// `surf-research-skill serach "q"` on a machine with no key yet answers
// "configuration is broken, no valid Brave key" (78) when the truth is "you
// typed it wrong" (2), and the agent goes off fixing the wrong thing. A verb
// added to the switch but forgotten here fails loudly and immediately, which
// is the safe direction — it can never turn into a keyless search.
const KNOWN_VERBS = new Set([
  'ai', 'surf-search-normal', 'surf-search-unlimit', 'surf-search-unlimited',
  'ai-setup', 'search', 'search-parallel', 'cache-clear', 'cost', 'keys',
  'gate', 'setup', 'project-config',
]);
if (!KNOWN_VERBS.has(cmd) && !REMOVED_VERBS.has(cmd)) {
  usage(`Unknown command: ${cmd}. Try 'surf-research-skill --help'.`);
}

if (!NO_KEYS_NEEDED.has(cmd) && !REMOVED_VERBS.has(cmd)) {
  const state = await loadState();
  try {
    await assertProviderReady(state, 'brave');
  } catch (e) {
    if (!(e instanceof GateError)) throw e;
    if (!process.stdin.isTTY) {
      process.stderr.write(e.message + '\n');
      process.exit(EXIT_CONFIG);
    }
    process.stderr.write(e.message + '\n\n— Launching setup so you can fix it now —\n\n');
    try {
      await runSetup();
    } catch {
      process.exit(EXIT_CONFIG);
    }
    try {
      await assertProviderReady(await loadState(), 'brave');
      process.stderr.write('\n— Resuming your command —\n\n');
    } catch (again) {
      process.stderr.write((again.message || String(again)) + '\n');
      process.exit(EXIT_CONFIG);
    }
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
    case 'cache-clear': await cmdCacheClear(); break;
    case 'cost': await cmdCost(pos, flags); break;
    case 'keys': await cmdKeys(pos, flags); break;
    case 'gate': await cmdGate(pos, flags); break;
    case 'setup': await runSetup(); break;
    case 'project-config': {
      const result = await runProjectConfig(pos, flags);
      out(formatProjectConfigResult(result, { json: !!flags.json }));
      break;
    }
    default:
      if (REMOVED_VERBS.has(cmd)) {
        usage(
          `'${cmd}' was removed in v8.0.0. Brave Search is a SERP: /web/search returns ranked ` +
          `links and snippets, never page content, and has no crawl, site-map or async-research ` +
          `endpoint. Use 'search' and follow the returned URLs with your own reader.`,
        );
      }
      // Unreachable: KNOWN_VERBS rejects a typo before the gate. Kept as the
      // safety net for a verb added to KNOWN_VERBS but not to this switch.
      usage(`Unknown command: ${cmd}. Try 'surf-research-skill --help'.`);
  }
} catch (e) {
  reportFatal(e);
}
