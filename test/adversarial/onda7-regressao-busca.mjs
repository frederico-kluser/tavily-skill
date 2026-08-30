#!/usr/bin/env node
// ONDA 7 — regression suite for the integrated fixes of surf-agent-skill@8.0.1.
//
// Four fronts, one file. Every assertion below pins the CORRECTED behaviour of
// the merged code (this suite only runs against the integrated main, where the
// fixes are already in). A failure here is either a real regression or a
// mistake in this suite — never "expected behaviour that will change later".
//
//   F3  src/lib/api/search.mjs          — keyless rejection (exit 78), usage
//       errors before the first fetch, traffic dedup, subAgents floor, unique
//       caller ids, no-budget passthrough, keyless cache hits (deliberate).
//   F5  src/lib/ai/{orchestrator,frontier,heuristics,prompts}.mjs
//                                      — 7 search flags on the wire, forget()
//       for failed searches, empty question -> 0 queries, maxQueries 0 -> 0,
//       subAgents/maxDepth 0 -> 1, phantom branch closes reach the analyst
//       prompt.
//   F6  src/lib/{ratelimit,cache}.mjs   — "1, " unknown, "0, -5" -> 0, min-wins
//       on contradictory w=1 policies, finite rps when pacing is off, null
//       learnFromBody still records plan+counters, paced only after a real
//       sleep, canonical cacheKey.
//   F15 src/lib/providers/brave.mjs     — invalid --start-date warns
//       "unfiltered" and drops (NEVER silent); valid YYYY-MM-DD accepted.
//
// QUOTA: zero. globalThis.fetch is stubbed before any library import, HOME is
// a throwaway directory (H10: module-level consts freeze at import, so the
// temp HOME must exist BEFORE the first import), and SURF_BRAVE_API_BASE
// points at an unroutable host as a second belt-and-suspenders layer. The
// child additionally runs from a NEUTRAL cwd (an empty directory under the
// throwaway HOME): discoverKeys level 3 parses a `.env` sitting at
// process.cwd(), so a real BRAVE_API_KEY there would fake the keyless tests
// green on the wrong path. Under npm test the NODE_OPTIONS preload
// additionally makes any real socket/fetch attempt fail loudly.
//
// Run:
//   NODE_OPTIONS="--require /tmp/surf-audit-20260830/test-busca/preload-zero-rede.cjs" \
//   HOME=$(mktemp -d) node test/adversarial/onda7-regressao-busca.mjs
//
// Wall time ~5s: two real ~1s pacing slots in a pacing-armed grandchild, plus
// two end-to-end surf-ai runs against the stub.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MODE = process.env.SURF_ADV_MODE || '';

// ---------------------------------------------------------------- harness ---
// The parent's only job is to re-exec this file with HOME pointed at a
// throwaway directory (the H10 trap: CACHE_DIR / KEYS_FILE / DISABLED are all
// module-load constants, so the environment must be settled BEFORE the first
// import — which is exactly why the real work lives in the child).

if (!process.env.SURF_ADV_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-o7-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  mkdirSync(path.join(home, '.cache', 'surf'), { recursive: true });
  // The real environment must not leak search keys into the child: discoverKeys
  // reads process.env (level 2), so a user's BRAVE_API_KEY would turn the
  // keyless-rejection tests into live-probing ones. Strip every key source:
  // the four env names below (level 2) AND the cwd (level 3 — discoverKeys
  // parses a `.env` at process.cwd()). The child is spawned from a .env-free
  // directory under the throwaway HOME, so the suite still exercises the
  // keyless path even when run from a project directory that carries a real
  // .env with BRAVE_API_KEY.
  const childEnv = { ...process.env };
  for (const k of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) {
    delete childEnv[k];
  }
  const neutralCwd = path.join(home, 'cwd');
  mkdirSync(neutralCwd, { recursive: true });
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    cwd: neutralCwd,
    env: {
      ...childEnv,
      HOME: home,
      USERPROFILE: home,
      SURF_ADV_CHILD: '1',
      SURF_QUIET: '1',
      // One per-second budget for the whole child; the pacing-armed
      // grandchild deliberately UNSETS this (see grandchild()).
      SURF_NO_RATE_LIMIT: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      // No harness budget noise in the runSurfAi integration runs.
      SURF_AGENT_BUDGET_MS: '',
      BASH_DEFAULT_TIMEOUT_MS: '',
      PI_BASH_DEFAULT_TIMEOUT_SECONDS: '',
      OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: '',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

const LIB = (m) => new URL(`../../src/lib/${m}`, import.meta.url).href;
const out = (s) => process.stdout.write(s);

// ------------------------------------------------- pacing-armed grandchild ---
// The rate limiter reads SURF_NO_RATE_LIMIT once, at module load, so the
// ARMED behaviour can only be exercised in a fresh process. This grandchild
// runs with SURF_NO_RATE_LIMIT deleted.
if (MODE === 'pace') {
  const { CACHE_DIR } = await import(LIB('state.mjs'));
  const rl = await import(LIB('ratelimit.mjs'));
  const L = path.join(CACHE_DIR, 'ratelimit.json');
  const res = {};

  // 1. learnFromBody with the plan and the quota counters but NO rate_limit:
  //    the return value is null (nothing about req/s was learned) but the
  //    plan name and the monthly counter are recorded anyway.
  const ret = await rl.learnFromBody('partial-key', {
    error: { meta: { plan: 'Search', quota_limit: 2000, quota_current: 3 } },
  });
  res.learnRet = ret;
  res.plan = await rl.knownPlan('partial-key');
  res.monthly = await rl.monthlyRemaining('partial-key');

  // 2. paced is only true after a REAL sleep for a slot: on a 1 rps plan the
  //    first slot of a fresh window is granted immediately (paced:false, no
  //    matter how long the lock+read took) and the second one actually waits.
  writeFileSync(L, JSON.stringify({}));
  let t = Date.now();
  const first = await rl.acquireSlot('paced-key');
  res.firstPaced = first.paced;
  res.firstMs = Date.now() - t;
  t = Date.now();
  const second = await rl.acquireSlot('paced-key');
  res.secondPaced = second.paced;
  res.secondMs = Date.now() - t;

  out(JSON.stringify(res));
  process.exit(0);
}

// ------------------------------------------------------------- assertions ---

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; out(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); out(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { out(`\n${t}\n`); }
async function attempt(fn) {
  try { return { value: await fn() }; } catch (e) { return { err: e }; }
}
function grandchild(mode, extraEnv = {}) {
  const env = { ...process.env, SURF_ADV_MODE: mode, ...extraEnv };
  delete env.SURF_NO_RATE_LIMIT; // pacing ARMED in the grandchild
  const r = spawnSync(process.execPath, [SELF], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env,
  });
  if (r.status !== 0) throw new Error(`grandchild '${mode}' exited ${r.status}: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

// ------------------------------------------------ the stubbed network -------
// Installed BEFORE any library import, so nothing this suite touches can ever
// spend a Brave credit. `q`-bearing URLs are real searches; a URL without `q`
// is a key-validation probe (422 VALIDATION proves the key for free).
const net0 = { total: 0, search: 0, qs: [], urls: [], delayMs: 0 };
function http(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url) => {
  net0.total += 1;
  const u = new URL(String(url));
  if (!u.searchParams.has('q')) return http(422, { error: { code: 'VALIDATION' } });
  net0.search += 1;
  net0.qs.push(u.searchParams.get('q'));
  net0.urls.push(u.toString());
  if (net0.delayMs) await new Promise((r) => setTimeout(r, net0.delayMs));
  const count = Number(u.searchParams.get('count')) || 5;
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push({ url: `https://r${i}.example/${net0.search}`, title: `Result ${i}`, description: 'd' });
  }
  return http(200, { web: { results }, query: { more_results_available: false } });
};

const { search: libSearch, searchParallel } = await import(LIB('api/search.mjs'));
const brave = await import(LIB('providers/brave.mjs'));
const { resolveFreshness } = brave;
const rl = await import(LIB('ratelimit.mjs'));
const cache = await import(LIB('cache.mjs'));
const { CACHE_DIR } = await import(LIB('state.mjs'));
const { progress } = await import(LIB('progress.mjs'));

// ================================================================ F3: api/search ===
// Contract: the exit-78 invariant on the library path, usage errors before the
// first fetch, traffic dedup, the subAgents floor, unique ids, no-budget, and
// the deliberate keyless cache hit.

section('F3 api/search: keyless rejection (exit-78 invariant on the library path)');
{
  const before = net0.search;
  const r1 = await attempt(() => searchParallel(['kL parallel question'], {}));
  eq('searchParallel keyless rejects with BraveKeyMissing',
    r1.err && r1.err.code, 'BraveKeyMissing');
  eq('...carrying exitCode 78', r1.err && r1.err.exitCode, 78);
  eq('...and no library work was billed', net0.search - before, 0);

  const r2 = await attempt(() => libSearch('kL sequential question', {}));
  eq('sequential search keyless rejects with BraveKeyMissing',
    r2.err && r2.err.code, 'BraveKeyMissing');
  eq('...carrying exitCode 78', r2.err && r2.err.exitCode, 78);

  const r3 = await attempt(() => libSearch(['kL batch one', 'kL batch two'], {}));
  eq('a keyless BATCH also rejects (no survivor)', r3.err && r3.err.code, 'BraveKeyMissing');
  eq('...carrying exitCode 78', r3.err && r3.err.exitCode, 78);
  eq('the whole keyless block cost zero fetches', net0.search - before, 0);
}

section('F3 api/search: usage errors land BEFORE the first fetch');
{
  const before = net0.search;
  const a = await attempt(() => libSearch('enum q', { topic: 'bogus' }));
  eq('single search: invalid enum -> FLAG_USAGE', a.err && a.err.code, 'FLAG_USAGE');
  const b = await attempt(() => libSearch(['e1', 'e2'], { mode: 'bogus' }));
  eq('sequential batch: invalid enum -> FLAG_USAGE', b.err && b.err.code, 'FLAG_USAGE');
  const c = await attempt(() => searchParallel(['p1', 'p2'], { time: 'bogus' }));
  eq('parallel fan-out: invalid enum -> FLAG_USAGE', c.err && c.err.code, 'FLAG_USAGE');
  eq('usage errors cost zero fetches (validation ran before the loop)',
    net0.search - before, 0);
}

section('F3 api/search: traffic dedup — 3 identical queries are ONE search, three results');
{
  const before = net0.search;
  const r = await attempt(() => searchParallel(['triple identical query', 'triple identical query', 'triple identical query'], { braveKey: 'k', subAgents: 1 }));
  ok('a fan-out of 3 identical queries resolves', r.value && !r.err, JSON.stringify(r.err));
  eq('exactly ONE search fetch on the wire', net0.search - before, 1);
  eq('the caller still receives 3 batch entries', r.value.data.batches.length, 3);
  eq('all 3 entries succeeded', r.value.summary.succeeded, 3);
  eq('summary.total is the input count, not the deduped count', r.value.summary.total, 3);
  eq('every entry carries its own id', r.value.data.batches.map(b => b.id).join(','), 'q1,q2,q3');
}

section('F3 api/search: subAgents:0 means sequential, not the 10 default');
{
  const r = await attempt(() => searchParallel(['s0 one', 's0 two', 's0 three'], { braveKey: 'k', subAgents: 0 }));
  ok('subAgents:0 run resolves', r.value && !r.err, JSON.stringify(r.err));
  eq('concurrency clamps to the minimum of 1 (not 10)', r.value.summary.concurrency, 1);
  eq('all 3 queries still ran', r.value.summary.succeeded, 3);
}

section('F3 api/search: duplicate caller-supplied ids get a suffix');
{
  const r = await attempt(() => searchParallel(
    [{ id: 'x', q: 'dup id a' }, { id: 'x', q: 'dup id b' }, { id: 'x', q: 'dup id c' }, { q: 'dup id d' }, { q: 'dup id e' }],
    { braveKey: 'k', subAgents: 5 },
  ));
  ok('the 5-query fan-out resolves', r.value && !r.err, JSON.stringify(r.err));
  const ids = r.value.data.batches.map(b => b.id);
  eq('first claim keeps the base id', ids[0], 'x');
  eq('later claims get #2, #3 suffixes', ids[1] + ',' + ids[2], 'x#2,x#3');
  eq('plain-string items fall back to position ids', ids[3] + ',' + ids[4], 'q4,q5');
  eq('all ids are unique', new Set(ids).size, ids.length);
}

section('F3 api/search: noBudget is repassed to dispatch');
{
  // With a tiny harness budget in the environment, the DEFAULT (noBudget not
  // passed, i.e. the library's `no-budget: true`) must sail through the
  // self-budget abort; an explicit noBudget:false must trip LikelyAgentTimeout.
  process.env.SURF_AGENT_BUDGET_MS = '400';
  try {
    net0.delayMs = 150;
    const a = await attempt(() => libSearch('nobudget default survives', { braveKey: 'k' }));
    net0.delayMs = 0;
    ok('default noBudget (true) skips the self-budget abort', a.value && !a.err,
      JSON.stringify(a.err && { code: a.err.code, message: a.err.message }));
    const b = await attempt(() => libSearch('nobudget explicit false trips', { braveKey: 'k', noBudget: false }));
    eq('noBudget:false honours the detected budget -> LikelyAgentTimeout',
      b.err && b.err.code, 'LikelyAgentTimeout');
  } finally {
    delete process.env.SURF_AGENT_BUDGET_MS;
  }
}

section('F3 api/search: a cache hit is still served with no key at all (deliberate)');
{
  const before = net0.search;
  const args = { query: 'cached keyless query' };
  await cache.cacheSet(cache.cacheKey('brave', 'search', args), {
    provider: 'brave', usage: { credits: 0 }, latency_ms: 1,
    data: { query: args.query, results: [{ url: 'https://from-cache.example' }] },
  });
  const p = await attempt(() => searchParallel([args.query], {}));
  ok('keyless parallel fan-out served from cache', p.value && p.value.summary.succeeded === 1,
    JSON.stringify(p.err && { code: p.err.code, message: p.err.message }));
  eq('no keyless rejection despite zero keys', p.value && !p.err, true);
  const s = await attempt(() => libSearch('cached keyless query', {}));
  ok('sequential search also served from cache without a key', s.value && s.value.data,
    JSON.stringify(s.err && s.err.code));
  eq('the cache hits cost zero fetches (the point of the design)', net0.search - before, 0);
}

// ================================================================= F5: orchestrator / frontier / heuristics ===
// Contract: the 7 search flags reach the wire, forget() only on failed
// searches, empty question -> 0 queries, maxQueries:0 -> 0, subAgents/maxDepth
// 0 -> minimum 1, phantom branch closes reach the analyst prompt.

section('F5 frontier: a FAILED search can be re-proposed; a succeeded one cannot');
{
  const { Frontier, makeNode } = await import(LIB('ai/frontier.mjs'));
  const f = new Frontier({ maxDepth: 3 });
  const q = 'what is the capital of lantern land';
  eq('first proposal is admitted', f.admit(makeNode({ q, sub: 'sq1', depth: 0 })).admitted, true);
  eq('...and its bar is the permanent one while the search is credited',
    f.admit(makeNode({ q, sub: 'sq1', depth: 0 })).admitted, false);
  eq('forget() lifts the bar (the search failed; the query never produced anything)',
    f.forget(q), true);
  eq('forget on an already-lifted bar is a no-op (idempotent)', f.forget(q), false);
  eq('the identical query is admissible again after the failure',
    f.admit(makeNode({ q, sub: 'sq1', depth: 0 })).admitted, true);
  eq('re-admission re-bars the key, so forget now lifts it again', f.forget(q), true);
  eq('forget on a query never proposed is a no-op', f.forget('never asked anything about'), false);

  const g = new Frontier({ maxDepth: 3 });
  g.admit(makeNode({ q: 'kraken migration patterns', sub: 'sq1', depth: 0 }));
  eq('a SUCCEEDED search keeps its bar (no forget called by the loop)',
    g.admit(makeNode({ q: 'kraken migration patterns', sub: 'sq1', depth: 0 })).admitted, false);
}

section('F5 heuristics: empty question and maxQueries:0 emit ZERO queries');
{
  const { heuristicPlan } = await import(LIB('ai/heuristics.mjs'));
  eq('a blank question -> 0 queries', heuristicPlan({ question: '   ' }).queries.length, 0);
  eq('an absent question -> 0 queries', heuristicPlan({ goal: 'just a goal' }).queries.length, 0);
  eq('the plan shape survives the empty question',
    heuristicPlan({ question: '  ' }).sub_questions.length, 3);
  eq('maxQueries:0 -> 0 queries', heuristicPlan({ question: 'real question' }, { maxQueries: 0 }).queries.length, 0);
  eq('maxQueries:"0" -> 0 queries', heuristicPlan({ question: 'real question' }, { maxQueries: '0' }).queries.length, 0);
  eq('maxQueries:2 caps at 2', heuristicPlan({ question: 'real question' }, { maxQueries: 2 }).queries.length, 2);
  ok('a real question still yields queries without maxQueries',
    heuristicPlan({ question: 'real question' }).queries.length >= 1);
}

section('F5 orchestrator: subAgents:0 and maxDepth:0 clamp to the minimum (1)');
{
  // keys.json with a fresh validation verdict: the gate is READY offline, so
  // the integration runs never probe and never depend on the stub's verdict.
  const cfgDir = path.join(process.env.HOME, '.config', 'surf');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, 'keys.json'), JSON.stringify({
    schema_version: 1,
    brave: { keys: ['k'], current: 0, burned: [], cooldowns: [], validated: [{ index: 0, ok: true, at: new Date().toISOString(), reason: null }] },
    openrouter: { keys: [], current: 0, burned: [], cooldowns: [], validated: [] },
  }));

  const { runSurfAi } = await import(LIB('ai/orchestrator.mjs'));
  const run = await attempt(() => runSurfAi(
    { question: 'knob clamp integration question' },
    { mode: 'normal', subAgents: 0, maxDepth: 0, maxQueries: 0 },
  ));
  ok('the 0-knob run resolves', run.value && !run.err, JSON.stringify(run.err && run.err.message));
  eq('subAgents:0 -> minimum 1 (reported honestly in diagnostics)',
    run.value && run.value.diagnostics.subAgents, 1);
  eq('maxDepth:0 -> minimum 1', run.value && run.value.diagnostics.maxDepth, 1);
  eq('maxQueries:0 -> minimum 1 (never below the wave width)',
    run.value && run.value.diagnostics.maxQueries, 1);
}

section('F5 orchestrator: the 7 search flags reach the wire of runOneSearch');
{
  const { runSurfAi } = await import(LIB('ai/orchestrator.mjs'));
  const before = net0.urls.length;
  const flags = {
    domains: 'example.com,second.example',
    exclude: 'excluded.example',
    time: 'week',
    country: 'br',
    safesearch: 'moderate',
    goggles: 'https://goggles.example/x.goggles',
    'result-filter': 'ethereum',
  };
  const run = await attempt(() => runSurfAi(
    { question: 'wire flags integration question' },
    { mode: 'normal', flags },
  ));
  ok('the flagged search run resolves', run.value && !run.err, JSON.stringify(run.err && run.err.message));
  const urls = net0.urls.slice(before);
  ok('the run actually issued searches against the stub', urls.length >= 1, `${urls.length} search request(s)`);
  const p = (u) => new URL(u).searchParams;
  ok('--domains reached the wire query as an OR group',
    urls.every(u => /\(site:example\.com OR site:second\.example\)/.test(p(u).get('q'))),
    urls.map(u => p(u).get('q')).join(' | '));
  ok('--exclude reached the wire query as -site:',
    urls.every(u => p(u).get('q').includes('-site:excluded.example')), urls.map(u => p(u).get('q')).join(' | '));
  ok('--time reached the wire as freshness', urls.every(u => p(u).get('freshness') === 'pw'),
    urls.map(u => p(u).get('freshness')).join(','));
  ok('--country reached the wire', urls.every(u => p(u).get('country') === 'br'),
    urls.map(u => p(u).get('country')).join(','));
  ok('--safesearch reached the wire', urls.every(u => p(u).get('safesearch') === 'moderate'),
    urls.map(u => p(u).get('safesearch')).join(','));
  ok('--goggles reached the wire', urls.every(u => p(u).get('goggles') === 'https://goggles.example/x.goggles'),
    urls.map(u => p(u).get('goggles')).join(','));
  ok('--result-filter reached the wire', urls.every(u => p(u).get('result_filter') === 'ethereum'),
    urls.map(u => p(u).get('result_filter')).join(','));
}

section('F5 frontier/orchestrator: phantom branch closes are recorded AND told to the analyst');
{
  const { Frontier, makeNode } = await import(LIB('ai/frontier.mjs'));
  const f = new Frontier({ maxDepth: 3 });
  eq('closing a branch that never existed returns 0 and records a phantom',
    f.closeBranch('ghost', 'the analyst reported it answered'), 0);
  eq('the phantom close does NOT close the id', f.closed.has('ghost'), false);
  eq('...but is published in the snapshot', f.toJSON().phantom_closed_branches.includes('ghost'), true);
  eq('a second phantom close of the same id stays phantom', f.closeBranch('ghost'), 0);

  // The branch is not barred: a real node for the same sub is still admissible.
  eq('a phantom-close id does not bar admission',
    f.admit(makeNode({ q: 'a brand new question about the ghost sub', sub: 'ghost', depth: 0 })).admitted, true);

  // ---- The end-to-end wiring, driven for real -----------------------------
  // The orchestrator feeds the analyst every phantom close inside `rejected`
  // (orchestrator.mjs:401-414: `rejected = [...frontier.rejected, ...[...frontier
  // .phantomClosed].map(sub => ({...}))]`). This used to be REPLICATED here,
  // line by line — a copy that stayed green if that spread ever disappeared
  // from the orchestrator. Now the loop itself is driven: a stub LLM answers
  // the plan, then an analysis that closes branch 'ghost-q' (a sub-question
  // that NEVER existed), then a second analysis round — and the prompt the
  // stub receives on that second call is inspected for the wiring's signature.
  // Remove the spread from the orchestrator and this block goes red.
  const cfgDir = path.join(process.env.HOME, '.config', 'surf');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, 'keys.json'), JSON.stringify({
    schema_version: 1,
    brave: { keys: ['k'], current: 0, burned: [], cooldowns: [], validated: [{ index: 0, ok: true, at: new Date().toISOString(), reason: null }] },
    openrouter: { keys: ['or-k'], current: 0, burned: [], cooldowns: [], validated: [] },
  }));

  const baseFetch = globalThis.fetch;
  const orCalls = [];
  let orScript = [];
  const orChat = (content) => () => ({
    ok: true, status: 200, headers: new Map(),
    text: async () => JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { total_tokens: 100, cost: 0.0001 },
      model: 'deepseek/deepseek-v4-pro',
    }),
  });
  const PHANTOM_PLAN = JSON.stringify({
    restated_objective: 'answer the phantom question',
    sub_questions: [{ id: 'sq1', question: 'the core question', why: 'core' }],
    queries: [{ id: 'q1', q: 'phantom seed question one', sub: 'sq1', category: 'official-docs', priority: 0.9 }],
    success_criteria: ['a primary source confirms it'],
  });
  const ROUND1_ANALYSIS = JSON.stringify({
    resolved: false, confidence: 'high', coverage: ['partial'],
    open_points: ['still open'],
    next_queries: [{ id: 'fq1', q: 'phantom follow-up question two', sub: 'sq1', category: 'official-docs', parent: 'q1', priority: 0.5, kind: 'depth' }],
    branches_to_close: ['ghost-q'], saturation: false, stop_reason: 'keep digging',
  });
  const ROUND2_ANALYSIS = JSON.stringify({
    resolved: true, confidence: 'high', coverage: [], open_points: [],
    next_queries: [], branches_to_close: [], saturation: false, stop_reason: 'criteria met',
  });
  const schemaName = (body) => body.response_format && body.response_format.json_schema && body.response_format.json_schema.name;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('openrouter') && u.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      orCalls.push(body);
      const next = orScript.shift() || (
        schemaName(body) === 'surf_ai_plan' || schemaName(body) === 'surf_ai_analysis'
          ? orChat(ROUND2_ANALYSIS)
          : orChat('# Answer\nstub synthesis [1].')
      );
      return next();
    }
    return baseFetch(url, init);
  };
  try {
    const { runSurfAi } = await import(LIB('ai/orchestrator.mjs'));
    orScript = [orChat(PHANTOM_PLAN), orChat(ROUND1_ANALYSIS), orChat(ROUND2_ANALYSIS)];
    const run = await attempt(() => runSurfAi(
      { question: 'phantom close end-to-end question' },
      { mode: 'unlimit', maxRounds: 3, maxQueries: 4 },
    ));
    ok('the phantom-closing run resolves (two waves, live analyst)', run.value && !run.err,
      JSON.stringify(run.err && run.err.message));
    eq('the loop ran two full rounds before resolving', run.value && run.value.rounds, 2);
    const analyseCalls = orCalls.filter(c => schemaName(c) === 'surf_ai_analysis');
    const promptOf = (c) => (c.messages || []).map(m => m.content).join('\n');
    ok('the analyst was genuinely called twice (LLM path live, not degraded)',
      analyseCalls.length >= 2, `${analyseCalls.length} analyse call(s)`);
    ok('the FIRST analysis prompt does not yet mention the phantom',
      analyseCalls.length >= 1 && !promptOf(analyseCalls[0]).includes('never existed'),
      'the phantom leaked one round early');
    ok('the SECOND analysis prompt carries the orchestrator wiring — "(close requested for branch \'ghost-q\')"',
      analyseCalls.length >= 2 && promptOf(analyseCalls[1]).includes("(close requested for branch 'ghost-q')"),
      'not found in the second analysis prompt');
    ok('...with the "never existed" reason from orchestrator.mjs:401-414',
      analyseCalls.length >= 2 && promptOf(analyseCalls[1]).includes('that sub-question never existed, so the close was ignored'),
      'not found in the second analysis prompt');
    ok('the run\'s own snapshot records the phantom close',
      run.value && (run.value.frontier.phantom_closed_branches || []).includes('ghost-q'),
      JSON.stringify(run.value && run.value.frontier.phantom_closed_branches));
    ok('no analyse stage degraded (the composition under test is the integrated one)',
      run.value && !(run.value.diagnostics.degraded || []).some(d => d.stage === 'analyze'),
      JSON.stringify(run.value && run.value.diagnostics.degraded));
    ok('the run still produced an answer', run.value && !!run.value.answer, 'empty answer');
  } finally {
    globalThis.fetch = baseFetch;
  }

  // And the real close still works as documented: it drops pending nodes and
  // bars the branch.
  const h = new Frontier({ maxDepth: 3 });
  h.admit(makeNode({ q: 'branch close real question', sub: 'sq1', depth: 0 }));
  eq('closing a real branch drops its pending node', h.closeBranch('sq1'), 1);
  eq('...and closes it for good', h.closed.has('sq1'), true);
  eq('...refusing later queries for that branch',
    h.admit(makeNode({ q: 'late question for sq1', sub: 'sq1', depth: 0 })).admitted, false);
  eq('the real close is not a phantom', h.toJSON().phantom_closed_branches.length, 0);
}

// =================================================================== F6: ratelimit / cache ===
// Contract: honest monthly parsing, min-wins on contradictory policies, finite
// rps when pacing is off, learnFromBody without rate_limit still records,
// paced only after a real sleep, canonical cache key.

section('F6 ratelimit: monthly remaining parses honestly');
eq('"1, " reports UNKNOWN, never 0', rl.parseMonthlyRemaining('1, '), null);
eq('"0, -5" clamps to 0, never stays negative', rl.parseMonthlyRemaining('0, -5'), 0);
eq('the documented pair still parses', rl.parseMonthlyRemaining('0, 118'), 118);
eq('"0, " (dangling comma) is unknown too', rl.parseMonthlyRemaining('0, '), null);

section('F6 ratelimit: contradictory w=1 policies — the SMALLEST allowance wins');
eq('"9;w=1, 1;w=1" -> 1 (min)', rl.parsePerSecond('9;w=1, 1;w=1', null), 1);
eq('"1;w=1, 9;w=1" -> 1 (order-independent)', rl.parsePerSecond('1;w=1, 9;w=1', null), 1);
eq('"9;w=1, 2;w=1, 5;w=1" -> 2', rl.parsePerSecond('9;w=1, 2;w=1, 5;w=1', null), 2);
eq('a single policy is unchanged by min-wins', rl.parsePerSecond('50;w=1, 20000000;w=2592000', null), 50);

section('F6 ratelimit: pacing disabled reports a FINITE rps through JSON');
{
  const slot = await rl.acquireSlot('off-key');
  ok('the disabled slot is not paced', slot.paced === false, JSON.stringify(slot));
  const viaJson = JSON.parse(JSON.stringify(slot));
  ok('rps round-trips through JSON as a finite number (never null)',
    Number.isFinite(viaJson.rps) && viaJson.rps !== null,
    `JSON rps=${JSON.stringify(viaJson.rps)}`);
  eq('the reported value is the sentinel, not a guessed plan', viaJson.rps, Number.MAX_SAFE_INTEGER);
}

section('F6 ratelimit: learnFromBody without rate_limit still records plan+counters (pacing armed)');
{
  const p = grandchild('pace');
  eq('learnFromBody returns null when meta.rate_limit is absent', p.learnRet, null);
  eq('...yet the plan name was recorded', p.plan, 'Search');
  eq('...and the monthly counter was recorded (2000 - 3)', p.monthly, 1997);
}

section('F6 ratelimit: paced is only true after a REAL sleep (pacing armed)');
{
  const p = grandchild('pace');
  eq('the first slot of a fresh window is granted unpaced', p.firstPaced, false);
  ok('...without any meaningful wait', p.firstMs < 500, `${p.firstMs}ms`);
  eq('the second slot on a 1 rps plan really paced', p.secondPaced, true);
  ok('...after a genuine ~1s sleep', p.secondMs >= 900 && p.secondMs <= 2500, `${p.secondMs}ms`);
}

section('F6 cache: the cache key is canonical');
eq('property order does not change the key',
  cache.cacheKey('brave', 'search', { a: 1, b: 2 }), cache.cacheKey('brave', 'search', { b: 2, a: 1 }));
eq('nested property order does not change the key either',
  cache.cacheKey('brave', 'search', { q: 'x', f: { m: 1, n: 2 } }),
  cache.cacheKey('brave', 'search', { f: { n: 2, m: 1 }, q: 'x' }));
ok('array ELEMENT order still changes the key (a list is ordered)',
  cache.cacheKey('brave', 'search', { q: [1, 2] }) !== cache.cacheKey('brave', 'search', { q: [2, 1] }));
ok('different queries still differ',
  cache.cacheKey('brave', 'search', { query: 'x' }) !== cache.cacheKey('brave', 'search', { query: 'y' }));

// =================================================================== F15: brave datases ===
// Contract: an unparseable bound is NEVER dropped in silence — progress.warn
// says "unfiltered" — and a real YYYY-MM-DD is still accepted.

section('F15 brave: invalid dates warn "unfiltered" and drop — never silently');
{
  const origWarn = progress.warn;
  const warns = [];
  progress.warn = (m) => warns.push(String(m));
  try {
    eq('01/01/2026 (ambiguous) is refused', resolveFreshness({ startDate: '01/01/2026' }), undefined);
    eq('12026-01-01 (5-digit year) is refused', resolveFreshness({ startDate: '12026-01-01' }), undefined);
    eq('2026-13-45 (impossible month/day) is refused', resolveFreshness({ startDate: '2026-13-45' }), undefined);
    eq('2026-02-30 (day out of range for the month) is refused', resolveFreshness({ startDate: '2026-02-30' }), undefined);
    eq('an invalid --freshness token is refused too', resolveFreshness({ freshness: 'pz' }), undefined);
  } finally {
    progress.warn = origWarn;
  }
  ok('every refused bound warned the user', warns.length >= 5, `${warns.length} warning(s): ${JSON.stringify(warns)}`);
  ok('...and every warning says the search ran unfiltered',
    warns.length >= 5 && warns.every(w => /unfiltered/.test(w)),
    JSON.stringify(warns.filter(w => !/unfiltered/.test(w))));
  ok('...naming the offending flag (--start-date)', warns.some(w => /--start-date/.test(w)), JSON.stringify(warns));
  ok('...and the dropped value', warns.some(w => /01\/01\/2026/.test(w)), JSON.stringify(warns));
}

section('F15 brave: a valid YYYY-MM-DD is still accepted');
{
  const origWarn = progress.warn;
  const warns = [];
  progress.warn = (m) => warns.push(String(m));
  try {
    eq('a valid range is forwarded', resolveFreshness({ startDate: '2026-01-31', endDate: '2026-02-28' }), '2026-01-31to2026-02-28');
    ok('a single valid --start-date builds a range to today',
      /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(resolveFreshness({ startDate: '2026-01-01' })),
      JSON.stringify(resolveFreshness({ startDate: '2026-01-01' })));
    // An invalid bound next to a valid one: the valid bound still wins, the
    // invalid one still announces itself. The CONTRACT (brave.mjs:390-396):
    // when only the end is valid the range still opens at a DERIVED default
    // lower bound; when only the start is valid it closes at today. The
    // literal of that derived bound is an implementation detail — pin the
    // shape (a real YYYY-MM-DD lower bound, the passed value as the upper
    // bound, range not inverted), not the sentinel value.
    const mixed = resolveFreshness({ startDate: '01/01/2026', endDate: '2026-02-01' });
    ok('invalid start + valid end keeps the valid bound (derived lower bound + passed upper bound)',
      typeof mixed === 'string' && /^\d{4}-\d{2}-\d{2}to2026-02-01$/.test(mixed),
      JSON.stringify(mixed));
    ok('...and the range is not inverted',
      typeof mixed === 'string' && mixed.split('to')[0] <= '2026-02-01',
      JSON.stringify(mixed));
  } finally {
    progress.warn = origWarn;
  }
  ok('the mixed case still warned about the dropped start', warns.some(w => /unfiltered/.test(w)), JSON.stringify(warns));
  eq('--time week still means pw', resolveFreshness({ time: 'week' }), 'pw');
}

// ---------------------------------------------------------------- summary ---

section('summary');
out(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) out(`  x ${f}\n`);

const zr = globalThis.__ZEROREDE__ || {};
out(`rede: ${zr.sockets || 0} socket(s), ${zr.lookups || 0} lookup(s), ${zr.realFetches || 0} real fetch(es) — ` +
    `stub: ${net0.total} total, ${net0.search} search fetch(es)\n`);
out(`md5 guarda: keys.json e ratelimit.json reais intocados (HOME=${process.env.HOME})\n`);

if (failures.length) process.exit(1);
out('onda7-regressao-busca-ok\n');