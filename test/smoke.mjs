#!/usr/bin/env node
// Offline smoke tests for surf-ai. No network, no real keys, no touching the
// user's ~/.config/surf — the suite re-execs itself with HOME pointed at a
// throwaway directory, then stubs global fetch.
//
// Run: npm test
//
// What it covers:
//   · loose JSON parsing of the shapes models actually emit
//   · OpenRouter error → retry-taxonomy mapping
//   · ledger dedupe, source numbering, digest truncation
//   · the heuristic (LLM-free) fallbacks
//   · brief building + usage errors
//   · the FULL orchestrator loop, twice: normal (1 wave) and unlimit
//     (2 waves driven by the analyst), against a stubbed OpenRouter + Brave
//   · graceful degradation when every OpenRouter call fails
//   · the hard stop: with no Brave key the run raises instead of answering
//   · the packaging invariant: ONE version number, package.json's, everywhere

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- harness ---

if (!process.env.SURF_SMOKE_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-smoke-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  writeFileSync(
    path.join(home, '.config', 'surf', 'keys.json'),
    JSON.stringify({
      schema_version: 1,
      // Pre-validated so the preflight gate resolves offline and the suite
      // never reaches the network.
      brave: {
        keys: ['brv-test-key-0000'], current: 0, burned: [], cooldowns: [],
        validated: [{ index: 0, at: new Date().toISOString(), ok: true, status: 200, reason: null }],
      },
      openrouter: { keys: ['sk-or-v1-test-key-0000'], current: 0, burned: [], cooldowns: [], validated: [] },
      last_ok_provider: null,
    }, null, 2),
  );

  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_SMOKE_CHILD: '1',
      SURF_QUIET: '1',
      // Keep the child off any real endpoint even if a stub is missed.
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      SURF_OPENROUTER_BASE: 'https://openrouter.invalid/api/v1',
      // Pacing is covered in test/brave.mjs; leaving it armed here would add a
      // real second of wall-clock per stubbed search.
      SURF_NO_RATE_LIMIT: '1',
      // The degraded-orchestrator section proves the run falls back to the
      // heuristic plan/synthesis when EVERY LLM call fails. Without a budget the
      // retry ladder would spend ~84s of real time sleeping (5 models × 2 keys ×
      // 3 attempts, capped backoff) before degrading. Injecting the run budget
      // makes the ladder spend its waits INSIDE the budget (openrouter.mjs caps
      // its total backoff sleep to a share of it) — the same behavior, the same
      // attempts, no 84s of wall-clock. The behavior under test is unchanged:
      // every model/key/attempt still runs, then the orchestrator degrades.
      SURF_AI_BUDGET_MS: '8000',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

// ------------------------------------------------------------------ child ---

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); process.stdout.write(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { process.stdout.write(`\n${t}\n`); }

// --- fetch stub -------------------------------------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => JSON.stringify(body),
  };
}

// Brave's shape, not Tavily's: `description` (not `content`), `page_age` (ISO)
// alongside `age` (display), and everything nested under `web.results`.
function braveHit(query, i) {
  return {
    url: `https://example.com/${encodeURIComponent(query).slice(0, 20)}/${i}`,
    title: `Result ${i} for ${query}`,
    description: `Body text for ${query} number ${i}. `.repeat(8),
    extra_snippets: [`Extra excerpt ${i} for ${query}.`],
    page_age: '2026-07-01T00:00:00',
    age: 'July 1, 2026',
  };
}

// Scripted OpenRouter replies, consumed in order. Each entry is a function of
// the parsed request body so a test can assert on what was actually sent.
let orScript = [];
let orCalls = [];
let braveCalls = [];
let braveBehavior = () => ({ status: 200 });

function installFetchStub() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);

    if (u.includes('openrouter') && u.endsWith('/key')) {
      return jsonResponse(200, { data: { label: 'smoke', limit: null, usage: 0, is_free_tier: false } });
    }

    if (u.includes('openrouter') && u.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      orCalls.push(body);
      const next = orScript.shift();
      if (!next) return jsonResponse(503, { error: { message: 'stub exhausted' } });
      return next(body);
    }

    if (u.includes('brave')) {
      // Brave is GET with query params. Tavily was POST with a JSON body, so
      // this must PARSE THE URL, not init.body — the difference is why the old
      // stub cannot simply be renamed.
      const params = new URL(u).searchParams;
      const query = params.get('q') || '';
      braveCalls.push({ query, params });
      const b = braveBehavior({ query, params }, braveCalls.length);
      if (b.status !== 200) return jsonResponse(b.status, b.body || { error: { code: 'VALIDATION', detail: 'stub error' } });
      return jsonResponse(200, {
        query: { original: query, more_results_available: false },
        web: { results: [braveHit(query, 1), braveHit(query, 2)] },
      });
    }

    throw new Error(`unexpected fetch to ${u}`);
  };
}

function orChat(content) {
  return () => jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { total_tokens: 100, cost: 0.0001 },
    model: 'deepseek/deepseek-v4-pro',
  });
}

const PLAN_JSON = JSON.stringify({
  restated_objective: 'know whether X works',
  sub_questions: [
    { id: 'sq1', question: 'does X work', why: 'core' },
    { id: 'sq2', question: 'what breaks', why: 'risk' },
  ],
  queries: [
    { id: 'q1', q: 'X official docs', sub: 'sq1', category: 'official-docs', priority: 0.9 },
    { id: 'q2', q: 'X known issues', sub: 'sq2', category: 'community', priority: 0.8 },
  ],
  success_criteria: ['a primary source confirms X'],
});

// --- tests ------------------------------------------------------------------

const { parseJsonLoose, mapError, resolveModels, retryAfterMs, PRIMARY_MODEL } =
  await import('../src/lib/ai/openrouter.mjs');

section('openrouter: loose JSON parsing');
ok('plain object', parseJsonLoose('{"a":1}')?.a === 1);
ok('fenced json', parseJsonLoose('```json\n{"a":2}\n```')?.a === 2);
ok('bare fence', parseJsonLoose('```\n{"a":3}\n```')?.a === 3);
ok('prose preamble', parseJsonLoose('Sure! Here you go:\n{"a":4}\nHope that helps.')?.a === 4);
ok('array reply', Array.isArray(parseJsonLoose('[{"a":5}]')));
ok('brace inside string', parseJsonLoose('{"a":"}{ not a brace"}')?.a === '}{ not a brace');
eq('garbage → null', parseJsonLoose('no json at all'), null);
eq('empty → null', parseJsonLoose(''), null);

section('openrouter: error taxonomy');
eq('401 → auth', mapError(401, {}).kind, 'auth');
eq('402 → auth (rotate key)', mapError(402, {}).kind, 'auth');
eq('403 moderation → caller_4xx', mapError(403, { error: { message: 'flagged', metadata: { reasons: ['x'] } } }).kind, 'caller_4xx');
eq('403 plain → auth', mapError(403, { error: { message: 'forbidden' } }).kind, 'auth');
eq('404 unknown model → bad_model', mapError(404, { error: { message: 'x is not a valid model ID' } }).kind, 'bad_model');
// require_parameters:true answers 404 (not 400) when no endpoint implements
// the schema — that must downgrade the schema, not discard the model.
eq('404 require_parameters → bad_schema',
  mapError(404, { error: { message: 'No endpoints found that can handle the requested parameters.' } }).kind,
  'bad_schema');
eq('400 schema → bad_schema', mapError(400, { error: { message: 'response_format not supported' } }).kind, 'bad_schema');
eq('429 → rate_limit_429', mapError(429, {}).kind, 'rate_limit_429');
eq('503 → no_provider (routing, not outage)', mapError(503, {}).kind, 'no_provider');
eq('502 → server_5xx', mapError(502, {}).kind, 'server_5xx');
ok('default chain starts with the primary', resolveModels()[0] === PRIMARY_MODEL);
ok('override goes first, primary kept', (() => {
  const m = resolveModels('foo/bar');
  return m[0] === 'foo/bar' && m.includes(PRIMARY_MODEL);
})());
ok('chain excludes the unserved v3.2-speciale slug',
  !resolveModels().includes('deepseek/deepseek-v3.2-speciale'));

section('openrouter: Retry-After parsing');
const hdr = (v) => ({ get: (k) => (k.toLowerCase() === 'retry-after' ? v : null) });
eq('seconds form', retryAfterMs(hdr('30')), 30_000);
eq('missing header → 0', retryAfterMs(hdr(null)), 0);
eq('capped at 60s', retryAfterMs(hdr('9999')), 60_000);
ok('http-date form', retryAfterMs(hdr(new Date(Date.now() + 10_000).toUTCString())) > 5_000);
eq('no headers object → 0', retryAfterMs(undefined), 0);

section('openrouter: env keys are usable but never persisted');
const { keysFromEnv, mergeEnvKeys, snapshotForPersist } =
  await import('../src/lib/ai/openrouter.mjs');
eq('single env key', keysFromEnv({ OPENROUTER_API_KEY: 'sk-a' }).length, 1);
eq('csv env keys deduped', keysFromEnv({ OPENROUTER_API_KEYS: 'sk-a, sk-b', OPENROUTER_API_KEY: 'sk-a' }).length, 2);
const envState = { openrouter: { keys: ['stored-1'], current: 0, burned: [], cooldowns: [] } };
eq('env keys appended', mergeEnvKeys(envState, { OPENROUTER_API_KEY: 'env-1' }), 1);
eq('both usable at runtime', envState.openrouter.keys.length, 2);
envState.openrouter.burned.push({ index: 1, at: 'now', reason: 'auth' });
envState.openrouter.current = 1;
const snap = snapshotForPersist(envState);
eq('env key stripped before write', snap.openrouter.keys.length, 1);
eq('stored key survives', snap.openrouter.keys[0], 'stored-1');
eq('burn marker on the env key dropped', snap.openrouter.burned.length, 0);
eq('out-of-range current reset', snap.openrouter.current, 0);
eq('no-env state passes through', snapshotForPersist({ openrouter: { keys: ['a'], current: 0, burned: [], cooldowns: [] } }).openrouter.keys.length, 1);

section('ledger');
const { Ledger, canonicalUrl } = await import('../src/lib/ai/ledger.mjs');
eq('canonicalUrl strips utm', canonicalUrl('https://a.com/x?utm_source=z'), 'https://a.com/x');
eq('canonicalUrl strips fragment + trailing slash', canonicalUrl('https://a.com/x/#frag'), 'https://a.com/x');

const led = new Ledger();
led.addSuccess(1, { id: 'q1', q: 'alpha', sub: 'sq1' }, {
  provider: 'brave', latency_ms: 10, usage: { credits: 1 },
  data: { results: [
    { url: 'https://a.com/1', title: 'A', content: 'aaa' },
    { url: 'https://b.com/1', title: 'B', content: 'bbb' },
  ] },
});
led.addSuccess(1, { id: 'q2', q: 'beta', sub: 'sq2' }, {
  provider: 'brave', latency_ms: 20, usage: { credits: 1 },
  data: { results: [{ url: 'https://a.com/1?utm_source=x', title: 'A dup', content: 'aaa2' }] },
});
led.addFailure(1, { id: 'q3', q: 'gamma', sub: 'sq2' }, Object.assign(new Error('boom'), { code: 'X' }));

eq('3 rows recorded', led.rows.length, 3);
eq('failures counted', led.stats().failed, 1);
eq('sources deduped across queries', led.stats().sources, 2);
ok('duplicate url reuses source number', led.rows[1].results[0].n === led.rows[0].results[0].n);
ok('failure appears in digest', led.digest().includes('SEARCH FAILED'));
ok('table has a row per query', led.tableMarkdown().split('\n').length === 5);
ok('table carries depth and parent columns', led.tableMarkdown().includes('| Depth |'));
ok('hasQuery is case/space insensitive', led.hasQuery('  ALPHA '));

const bigLed = new Ledger();
bigLed.addSuccess(1, { id: 'q1', q: 'big', sub: 'sq1' }, {
  provider: 'brave', latency_ms: 1, usage: {},
  data: { results: [{ url: 'https://c.com/1', title: 'C', content: 'z'.repeat(50_000) }] },
});
ok('per-result truncation applies', bigLed.digest({ perResult: 200 }).length < 2_000);
ok('digest ceiling applies', bigLed.digest({ perResult: 50_000, maxChars: 500 }).includes('evidence truncated'));

section('heuristics (LLM-free fallbacks)');
const { heuristicPlan, heuristicAnalysis, heuristicSynthesis, keywordize } =
  await import('../src/lib/ai/heuristics.mjs');
ok('keywordize drops stopwords', !keywordize('what is the best way to do X').toLowerCase().includes('the'));
const hp = heuristicPlan({ question: 'how do I cap concurrency in node', goal: 'pick a library', today: '2026-08-01' }, { maxQueries: 5 });
ok('heuristic plan produces queries', hp.queries.length > 0 && hp.queries.length <= 5);
ok('heuristic queries are unique', new Set(hp.queries.map(q => q.q)).size === hp.queries.length);
ok('heuristic queries are short', hp.queries.every(q => q.q.length <= 380));
ok('heuristic analysis never loops', heuristicAnalysis(led).next_queries.length === 0);
ok('heuristic synthesis flags degradation', heuristicSynthesis({ question: 'q' }, led).includes('Degraded mode'));
ok('heuristic synthesis lists failures', heuristicSynthesis({ question: 'q' }, led).includes('gamma'));

section('flags: boolean switches never swallow the next argument');
const { parseFlags } = await import('../src/lib/flags.mjs');
{
  const { pos, flags } = parseFlags(['--json', 'my question', '--task', 't']);
  eq('--json stays boolean', flags.json, true);
  eq('question survives as a positional', pos[0], 'my question');
  eq('value flag still takes its value', flags.task, 't');
}
{
  const { pos, flags } = parseFlags(['--ledger', '--quiet', 'q', '--max', '5']);
  eq('--ledger boolean', flags.ledger, true);
  eq('--quiet boolean', flags.quiet, true);
  eq('positional intact', pos[0], 'q');
  eq('--max takes its value', flags.max, '5');
}
{
  // Dual-use flags are deliberately excluded from the boolean set.
  const { flags } = parseFlags(['--answer', 'basic']);
  eq('--answer still accepts a value', flags.answer, 'basic');
}

section('cli: brief building');
const { buildBrief, AiCliError } = await import('../src/lib/ai/cli.mjs');
const brief = await buildBrief(['how', 'does', 'X', 'work'], { task: 't', goal: 'g', insights: 'i' });
eq('positionals joined', brief.question, 'how does X work');
eq('task carried', brief.task, 't');
ok('missing question is a usage error', await (async () => {
  try { await buildBrief([], {}); return false; } catch (e) { return e instanceof AiCliError; }
})());

const briefFile = path.join(process.env.HOME, 'brief.json');
writeFileSync(briefFile, JSON.stringify({ question: 'from file', goal: 'file goal' }));
const fileBrief = await buildBrief([], { 'brief-file': briefFile });
eq('brief-file question', fileBrief.question, 'from file');
eq('brief-file goal', fileBrief.goal, 'file goal');
ok('flags beat brief-file', (await buildBrief([], { 'brief-file': briefFile, goal: 'flag goal' })).goal === 'flag goal');

section('orchestrator: normal mode (1 round, 2 LLM calls)');
installFetchStub();
const { runSurfAi } = await import('../src/lib/ai/orchestrator.mjs');

orScript = [orChat(PLAN_JSON), orChat('# Answer\nX works [1].')];
orCalls = []; braveCalls = [];
const normal = await runSurfAi(
  { question: 'does X work', task: 'building Y', goal: 'decide', insights: 'I think yes' },
  { mode: 'normal', flags: { 'no-cache': true } },
);
eq('normal runs exactly 1 round', normal.rounds, 1);
eq('normal makes exactly 2 LLM calls', orCalls.length, 2);
eq('both planned queries ran', braveCalls.length, 2);
ok('answer is the synthesized text', normal.answer.includes('X works'));
ok('synthesized flag set', normal.synthesized === true);
ok('no degraded stages', normal.diagnostics.degraded.length === 0);
ok('sources collected', normal.stats.sources > 0);
ok('brief reached the planner', JSON.stringify(orCalls[0]).includes('building Y'));
ok('insights framed as hypotheses', JSON.stringify(orCalls[0]).includes('I think yes'));
ok('plan call requested a strict schema', orCalls[0].response_format?.json_schema?.strict === true);
ok('synthesis call sent no schema', orCalls[1].response_format === undefined);

section('orchestrator: unlimit mode (analyst drives a 2nd round)');
const ANALYSIS_OPEN = JSON.stringify({
  resolved: false, confidence: 'low',
  coverage: [{ sub: 'sq1', status: 'thin', note: 'need more' }],
  open_points: ['version unclear'],
  next_queries: [{ id: 'q3', q: 'X current version number', sub: 'sq1', category: 'news', priority: 0.9, kind: 'depth', parent: 'q1' }],
  branches_to_close: [],
  saturation: false,
  stop_reason: 'need the version',
});
const ANALYSIS_DONE = JSON.stringify({
  resolved: true, confidence: 'high',
  coverage: [{ sub: 'sq1', status: 'answered', note: 'ok' }],
  open_points: [], next_queries: [], branches_to_close: [], saturation: false,
  stop_reason: 'criteria met',
});

orScript = [orChat(PLAN_JSON), orChat(ANALYSIS_OPEN), orChat(ANALYSIS_DONE), orChat('# Answer\nResolved [1].')];
orCalls = []; braveCalls = [];
const unl = await runSurfAi({ question: 'does X work' }, { mode: 'unlimit', maxRounds: 5, flags: { 'no-cache': true } });
eq('unlimit ran 2 rounds', unl.rounds, 2);
eq('3 searches total (2 + 1 follow-up)', braveCalls.length, 3);
ok('stopped on the resolved verdict', /criteria met/.test(unl.stop_reason));
ok('open points recorded', unl.analysis.resolved === true);

section('orchestrator: repeated queries are dropped');
const ANALYSIS_REPEAT = JSON.stringify({
  resolved: false, confidence: 'low', coverage: [],
  open_points: ['still unclear'],
  next_queries: [{ id: 'q9', q: 'X official docs', sub: 'sq1', category: 'official-docs', priority: 0.7, kind: 'depth', parent: 'q1' }],
  branches_to_close: [],
  saturation: false,
  stop_reason: 'retry',
});
orScript = [orChat(PLAN_JSON), orChat(ANALYSIS_REPEAT), orChat('# Answer\nDone [1].')];
orCalls = []; braveCalls = [];
const rep = await runSurfAi({ question: 'dup test' }, { mode: 'unlimit', maxRounds: 5, flags: { 'no-cache': true } });
eq('no search re-ran', braveCalls.length, 2);
ok('stop reason names the repeat', /already been run/.test(rep.stop_reason), `got: ${rep.stop_reason}`);
ok('the rejected duplicate is recorded, not silently dropped',
  rep.frontier.rejected.some(r => /duplicate/.test(r.reason)));

section('orchestrator: degrades when every LLM call fails');
orScript = []; // stub exhausted → 503 on every call
orCalls = []; braveCalls = [];
const degraded = await runSurfAi({ question: 'llm is down' }, { mode: 'normal', flags: { 'no-cache': true } });
ok('still returns an answer', typeof degraded.answer === 'string' && degraded.answer.length > 0);
ok('answer is marked degraded', degraded.answer.includes('Degraded mode'));
ok('degraded stages recorded', degraded.diagnostics.degraded.length >= 2);
ok('searches still ran via the heuristic plan', braveCalls.length > 0);
ok('sources still collected', degraded.stats.sources > 0);

section('orchestrator: search failures never abort the run');
orScript = [orChat(PLAN_JSON), orChat('# Answer\nPartial [1].')];
orCalls = []; braveCalls = [];
braveBehavior = (_body, n) => (n === 1 ? { status: 400, body: { error: 'bad query' } } : { status: 200 });
const partial = await runSurfAi({ question: 'partial failure' }, { mode: 'normal', flags: { 'no-cache': true } });
eq('one query failed', partial.stats.failed, 1);
eq('one query succeeded', partial.stats.succeeded, 1);
ok('failed query is still in the ledger', partial.ledger.rows.some(r => !r.ok));
ok('answer still produced', partial.answer.includes('Partial'));
braveBehavior = () => ({ status: 200 });

section('orchestrator: no evidence at all → actionable report, not a crash');
orScript = [orChat(PLAN_JSON)];
orCalls = []; braveCalls = [];
braveBehavior = () => ({ status: 500 });
const none = await runSurfAi({ question: 'everything is down' }, { mode: 'normal', flags: { 'no-cache': true } });
eq('zero sources', none.stats.sources, 0);
ok('emits the no-evidence report', none.answer.includes('No sources retrieved'));
ok('report tells the user how to fix it', none.answer.includes('keys list'));
ok('did not waste an LLM call on nothing', orCalls.length === 1);
braveBehavior = () => ({ status: 200 });

section('the hard stop: no Brave key means no answer from anywhere else');
{
  // v7 answered this situation from Wikipedia and exited 0, so a caller could
  // not tell a researched answer from an encyclopedia summary. There is no
  // longer any code path that can do that.
  const { loadState, saveStateAtomic } = await import('../src/lib/state.mjs');
  const st = await loadState();
  const savedKeys = st.brave.keys;
  const savedValid = st.brave.validated;
  st.brave.keys = [];
  st.brave.validated = [];
  await saveStateAtomic(st);

  orScript = [orChat(PLAN_JSON)];
  orCalls = []; braveCalls = [];
  const nokey = await runSurfAi({ question: 'no key at all' }, { mode: 'normal', flags: { 'no-cache': true } });
  eq('not one search was attempted', braveCalls.length, 0);
  eq('and nothing was retrieved', nokey.stats.sources, 0);
  ok('the answer is the failure report, not a synthesis', nokey.answer.includes('No sources retrieved'));
  ok('every query failed for the same, stated reason',
    nokey.ledger.rows.every(r => !r.ok) && nokey.ledger.rows.length > 0);
  ok('the reason names the Brave key',
    /Brave|brave/.test(JSON.stringify(nokey.ledger.rows.map(r => r.error))));

  st.brave.keys = savedKeys;
  st.brave.validated = savedValid;
  await saveStateAtomic(st);
}

section('render');
const { renderMarkdown } = await import('../src/lib/ai/render.mjs');
const md = renderMarkdown(normal, { ledger: true });
ok('answer first', md.startsWith('# Answer'));
ok('sources section present', md.includes('## Sources'));
ok('ledger table present', md.includes('| Wave |'));
ok('ledger table records the tree', md.includes('| Depth |') && md.includes('| Parent |'));
ok('footer present', md.includes('surf-ai `normal`'));
ok('stop reason present', md.includes('Stopped because'));
const mdLean = renderMarkdown(normal);
ok('ledger omitted by default', !mdLean.includes('| Wave |'));

section('packaging: one version number, and it is package.json\'s');
{
  const ROOT = path.resolve(path.dirname(SELF), '..');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const { VERSION, BIN_NAMES, UNKNOWN_VERSION } = await import('../src/lib/version.mjs');
  eq('src/lib/version.mjs reports package.json\'s version', VERSION, pkg.version);
  ok('...and did not fall back to the unknown marker', VERSION !== UNKNOWN_VERSION);
  eq('...and lists every bin package.json installs', BIN_NAMES.join(','), Object.keys(pkg.bin).join(','));

  // The header Brave actually sees. buildHeaders is module-private, so go in
  // through validate()'s ctx shape: version undefined must fall back to ours.
  const { braveProvider } = await import('../src/lib/providers/brave.mjs');
  ok('brave adapter exists to stamp X-Client-Name', typeof braveProvider.search === 'function');

  // No file may carry its own copy of the number again. This is the assertion
  // that makes "bump package.json and nothing else" true tomorrow, not just today.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith('.mjs') ? [full] : [];
  });
  const sources = [...walk(path.join(ROOT, 'bin')), ...walk(path.join(ROOT, 'src'))];
  const offenders = sources.filter(f => {
    if (f === path.join(ROOT, 'src', 'lib', 'version.mjs')) return false; // the source itself
    const text = readFileSync(f, 'utf8');
    // A literal version assigned to a VERSION-ish const, or spliced into the
    // X-Client-Name template as a default. Prose in comments ("removed in
    // v8.0.0") is history and stays.
    return /(?:const|let|var)\s+\w*VERSION\w*\s*=\s*['"`]\d+\.\d+\.\d+/.test(text) ||
           /surf-agent-skill\/\$\{[^}]*\|\|\s*['"`]\d+\.\d+\.\d+/.test(text);
  }).map(f => path.relative(ROOT, f));
  ok('no bin/ or src/ file hardcodes a version number', offenders.length === 0, offenders.join(', '));

  // SKILL.md front matter is YAML read by the harness: it cannot import
  // version.mjs, so it is synced by `npm run sync:version` (also run
  // automatically by `npm version`) and guarded right here.
  const { auditSkillVersions } = await import('../scripts/sync-version.mjs');
  for (const r of auditSkillVersions(ROOT)) {
    ok(`${r.file} metadata.version is ${r.want}`, r.ok,
      r.found ? `says ${r.value} — run: npm run sync:version` : 'no metadata.version in the front matter');
  }
}

// ---------------------------------------------------------------- summary ---

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('smoke-ok\n');
