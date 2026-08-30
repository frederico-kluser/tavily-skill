#!/usr/bin/env node
// Adversarial tests for the surf-ai research LOOP, the deepening FRONTIER and
// the LEDGER. 100% offline: no Brave call, no OpenRouter call, no network of
// any kind. The suite re-execs itself with HOME pointed at a throwaway
// directory (so the user's ~/.config/surf is never touched), pre-seeds a
// validated fake Brave key so the preflight gate resolves without a request,
// then stubs globalThis.fetch.
//
// Run: node ./test/adversarial/loop-frontier.mjs
//
// Two kinds of assertion live here and they are counted separately:
//
//   ok()/eq() — CONTRACT. The behaviour is correct and must stay correct.
//               A failure fails the suite (exit 1).
//   bug()     — DEFECT. The assertion is written so that TRUE means "the bug
//               is still there". A confirmed bug is reported loudly but does
//               NOT fail the suite: this wave proves defects, it does not fix
//               them. If a bug stops reproducing the line says so, which is
//               the signal that a fix landed and the assertion should flip.
//
// Every orchestrator run is wrapped in a timeout. A test that hangs is worse
// than the bug it was hunting.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- harness ---

if (!process.env.SURF_ADV_LOOP_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-adv-loop-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  writeFileSync(
    path.join(home, '.config', 'surf', 'keys.json'),
    JSON.stringify({
      schema_version: 1,
      brave: {
        keys: ['brv-adversarial-key-0000'], current: 0, burned: [], cooldowns: [],
        validated: [{ index: 0, at: new Date().toISOString(), ok: true, status: 200, reason: null }],
      },
      openrouter: { keys: ['sk-or-v1-adversarial-0000'], current: 0, burned: [], cooldowns: [], validated: [] },
      last_ok_provider: null,
    }, null, 2),
  );

  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_ADV_LOOP_CHILD: '1',
      SURF_QUIET: '1',
      // Belt and braces: even if a stub is missed, these hosts do not resolve.
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      SURF_OPENROUTER_BASE: 'https://openrouter.invalid/api/v1',
      // The loop tests run dozens of stubbed searches; real pacing would add a
      // wall-clock second to each one and prove nothing about the loop.
      SURF_NO_RATE_LIMIT: '1',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

// ------------------------------------------------------------------ child ---

let passed = 0;
const failures = [];
const bugs = [];
const stale = [];

function ok(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); process.stdout.write(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** Assert a DEFECT is present. True = still broken. Never fails the suite. */
function bug(id, name, stillBroken, evidence) {
  if (stillBroken) {
    bugs.push({ id, name, evidence });
    process.stdout.write(`  ☢ BUG ${id} — ${name}${evidence ? `\n      evidence: ${evidence}` : ''}\n`);
  } else {
    stale.push(`${id} ${name}`);
    process.stdout.write(`  ○ ${id} NOT REPRODUCED (fixed?) — ${name}\n`);
  }
}
function section(t) { process.stdout.write(`\n${t}\n`); }

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(Object.assign(new Error(`TIMEOUT ${ms}ms: ${label}`), { code: 'TestTimeout' })), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// =========================================================================
// PART 1 — frontier.mjs, pure unit level (no fetch needed)
// =========================================================================

const { Frontier, makeNode, queryKey } = await import('../../src/lib/ai/frontier.mjs');

section('frontier/queryKey: what the normaliser preserves (contract)');
ok('version digits survive the short-token filter', queryKey('gpt 4 pricing') !== queryKey('gpt 5 pricing'));
ok('v1 and v2 stay distinct', queryKey('v1 api reference') !== queryKey('v2 api reference'));
ok('3.11 and 3.1 stay distinct', queryKey('python 3.11 asyncio') !== queryKey('python 3.1 asyncio'));
ok('case and punctuation are ignored', queryKey('Brave API, limits!') === queryKey('brave api limits'));
eq('an empty query has an empty key', queryKey(''), '');
eq('null/undefined do not throw', queryKey(undefined), '');
eq('whitespace only is empty', queryKey('   \t\n '), '');
eq('emoji only is empty', queryKey('\u{1F525}\u{1F680}✨'), '');
eq('a query of only <=2-char words has no key', queryKey('a an of to in on'), '');
// There is no stopword list at all: any 3-char filler survives, so the
// near-duplicate detector is simultaneously too tight (BUG-01/02) and too loose.
bug('BUG-35', 'queryKey keeps 3+ char stopwords, so adding "the" evades near-duplicate detection',
  queryKey('the docker rate limits') !== queryKey('docker rate limits'),
  `frontier.mjs:37 filters only on LENGTH, never on a stopword list — "${queryKey('the docker rate limits')}" vs "${queryKey('docker rate limits')}". The analyst can re-run an identical search by prefixing one filler word`);
ok('accents are preserved, so accented/unaccented are NOT deduped',
  queryKey('ação de dados') !== queryKey('acao de dados'));
ok('a 200k-char query still normalises', queryKey('lorem '.repeat(40_000)).length > 0);

section('frontier/queryKey: SEMANTIC COLLISIONS (Q1)');
// The key is a SORTED token set. Word order is erased, so any two questions
// built from the same words collide no matter what they mean.
bug('BUG-01', 'queryKey sorts tokens, so reversed relations collide',
  queryKey('docker faster than podman') === queryKey('podman faster than docker'),
  `frontier.mjs:38 (.sort()) — both → "${queryKey('docker faster than podman')}"`);
bug('BUG-01b', 'queryKey sorts tokens, so a reversed migration collides',
  queryKey('migrate from postgres to mysql') === queryKey('migrate from mysql to postgres'),
  `frontier.mjs:38 — both → "${queryKey('migrate from postgres to mysql')}"`);
// Tokens of <=2 chars WITHOUT a digit are dropped as noise. Short language
// names are exactly that shape.
bug('BUG-02', 'queryKey drops <=2-char tokens, collapsing short language names',
  queryKey('Go vs Rust performance') === queryKey('C++ vs Rust performance')
  && queryKey('Go vs Rust performance') === queryKey('R vs Rust performance'),
  `frontier.mjs:37 — "Go vs Rust performance", "C++ vs Rust performance" and "R vs Rust performance" all → "${queryKey('Go vs Rust performance')}"`);

{
  // The consequence: the frontier calls a semantic collision a "duplicate" and
  // the audit trail records a statement that is not true.
  const f = new Frontier();
  f.admit(makeNode({ q: 'docker faster than podman', sub: 'sq1' }));
  const r = f.admit(makeNode({ q: 'podman faster than docker', sub: 'sq1' }));
  bug('BUG-03', 'the opposite question is silently refused AND mislabelled a duplicate',
    r.admitted === false && /duplicate/.test(r.reason),
    `frontier.mjs:96 — reason recorded: "${r.reason}"`);
}

section('frontier/admit: boundaries (contract)');
{
  const f = new Frontier({ maxDepth: 2, minPriority: 0.15 });
  eq('priority exactly AT the threshold is admitted',
    f.admit(makeNode({ q: 'threshold priority query alpha', sub: 's', priority: 0.15 })).admitted, true);
  eq('a hair below the threshold is refused',
    f.admit(makeNode({ q: 'below threshold query bravo', sub: 's', priority: 0.1499 })).admitted, false);
  eq('depth exactly AT the cap is admitted',
    f.admit(makeNode({ q: 'depth at cap query charlie', sub: 's', depth: 2 })).admitted, true);
  eq('one deeper than the cap is refused',
    f.admit(makeNode({ q: 'depth over cap query delta', sub: 's', depth: 3 })).admitted, false);
  eq('an empty q is refused', f.admit(makeNode({ q: '', sub: 's' })).admitted, false);
  eq('a content-free q is refused', f.admit(makeNode({ q: 'a an of', sub: 's' })).admitted, false);
  eq('a null sub is fine', f.admit(makeNode({ q: 'no branch question echo', sub: null })).admitted, true);
  ok('every rejection is recorded', f.rejected.length === 4);
}

section('frontier/admit: rejection POISONS the key for every future reason');
{
  const f = new Frontier({ maxDepth: 1, minPriority: 0.5 });
  const q = 'redis cluster failover semantics';
  eq('too deep now', f.admit(makeNode({ q, sub: 'sq1', depth: 9 })).admitted, false);
  const later = f.admit(makeNode({ q, sub: 'sq1', depth: 0, priority: 0.99 }));
  bug('BUG-04', 'a query rejected for DEPTH can never be admitted later at depth 0',
    later.admitted === false && /duplicate/.test(later.reason),
    `frontier.mjs:110 (#reject adds the key to seen for EVERY reason) — second attempt reason: "${later.reason}"`);

  const f2 = new Frontier({ minPriority: 0.5 });
  const q2 = 'kafka exactly once delivery cost';
  f2.admit(makeNode({ q: q2, sub: 'sq1', priority: 0.1 })); // below the floor
  const promoted = f2.admit(makeNode({ q: q2, sub: 'sq1', priority: 1 }));
  bug('BUG-04b', 'a query rejected for LOW PRIORITY can never be re-proposed at high priority',
    promoted.admitted === false,
    `frontier.mjs:110 — reason: "${promoted.reason}"`);

  const f3 = new Frontier();
  const q3 = 'grpc streaming backpressure limits';
  f3.closeBranch('sq1');
  f3.admit(makeNode({ q: q3, sub: 'sq1' }));            // refused: branch closed
  const other = f3.admit(makeNode({ q: q3, sub: 'sq2' })); // a DIFFERENT branch
  bug('BUG-04c', 'a query refused because ITS branch closed is blocked in every other branch too',
    other.admitted === false,
    `frontier.mjs:110 — reason: "${other.reason}"`);
}

section('frontier/admit: unvalidated node shapes');
{
  const f = new Frontier({ minPriority: 0.15 });
  // admit() takes whatever object it is handed; only makeNode clamps.
  const raw = f.admit({ q: 'raw object with no priority field', sub: 's' });
  bug('BUG-05', 'admit() accepts a node with NO priority, bypassing the admission floor',
    raw.admitted === true && f.nodes.some(n => n.priority === undefined),
    'frontier.mjs:99 — `undefined < 0.15` is false, so the gate passes and the sort comparator then yields NaN');
  eq('makeNode coerces a NaN priority to 0.5', makeNode({ q: 'x', priority: 'abc' }).priority, 0.5);
  eq('makeNode does NOT coerce depth', typeof makeNode({ q: 'x', depth: 'abc' }).depth, 'string');
  eq('makeNode rejects an unknown kind', makeNode({ q: 'x', kind: 'wat' }).kind, 'breadth');
}

section('frontier/closeBranch, noteMiss, noteHit');
{
  const f = new Frontier();
  eq('closing an unknown branch drops nothing', f.closeBranch('ghost-branch'), 0);
  const after = f.admit(makeNode({ q: 'perfectly good new question here', sub: 'ghost-branch' }));
  bug('BUG-06', 'closeBranch() on a branch that never existed still blacklists it forever',
    after.admitted === false,
    `frontier.mjs:118 (closed.add runs before any node is inspected) — reason: "${after.reason}"`);

  eq('closeBranch(null) is a no-op', f.closeBranch(null), undefined);
  eq('noteMiss(null) is a no-op', f.noteMiss(null), false);
  eq('noteHit(null) does not throw', f.noteHit(null), undefined);
}
{
  const f = new Frontier();
  for (let i = 0; i < 3; i++) f.admit(makeNode({ q: `thin branch question ${i} zulu`, sub: 'sqX' }));
  eq('one barren wave does not close a branch', f.noteMiss('sqX'), false);
  eq('two barren waves close it', f.noteMiss('sqX'), true);
  eq('and its pending queries are dropped', f.size, 0);
  eq('a third miss on an already-closed branch is idempotent', f.noteMiss('sqX'), true);
  f.noteHit('sqX');
  eq('noteHit on a closed branch does NOT reopen it', f.admit(makeNode({ q: 'reopen attempt query yankee', sub: 'sqX' })).admitted, false);
}

section('frontier/popWave: the width ceiling (Q2)');
{
  const f = new Frontier();
  eq('an empty frontier yields an empty wave', f.popWave(10, { wave: 1 }).length, 0);
}
{
  const mk = (n, sub, extra = {}) => {
    const f = new Frontier({ maxDepth: 6 });
    for (let i = 0; i < n; i++) f.admit(makeNode({ q: `question number ${i} for ${sub} papa`, sub, ...extra }));
    return f;
  };
  eq('width 0 is floored to 1, not to zero', mk(5, 'a').popWave(0, { wave: 1 }).length, 1);
  eq('a negative width is floored to 1', mk(5, 'a').popWave(-7, { wave: 1 }).length, 1);
  eq('a NaN width is floored to 1', mk(5, 'a').popWave(NaN, { wave: 1 }).length, 1);
  eq('a fractional width floors', mk(5, 'a').popWave(2.9, { wave: 1 }).length, 2);
  eq('a width larger than the frontier takes everything', mk(4, 'a').popWave(99, { wave: 1 }).length, 4);
  eq('Infinity takes everything without looping forever', mk(6, 'a').popWave(Infinity, { wave: 1 }).length, 6);
  eq('a very high wave number still returns a wave', mk(5, 'a').popWave(3, { wave: 9_999 }).length, 3);
  eq('all nodes in ONE branch still fill the wave', mk(20, 'solo').popWave(10, { wave: 1 }).length, 10);
}
{
  // Randomised stress: the two properties Q2 asks about, over 400 random
  // frontiers with mixed depths, kinds, priorities and branch counts.
  let overWidth = 0, dupNode = 0, leaked = 0, maxSeen = 0;
  for (let t = 0; t < 400; t++) {
    const f = new Frontier({ maxDepth: 6 });
    const nBranches = 1 + (t % 5);
    const nNodes = 1 + (t % 23);
    for (let i = 0; i < nNodes; i++) {
      f.admit(makeNode({
        q: `stress query ${t} ${i} quebec romeo`,
        sub: `sq${i % nBranches}`,
        depth: i % 4,
        priority: ((i * 7 + t) % 100) / 100,
        kind: i % 5 === 0 ? 'verify' : (i % 3 === 0 ? 'depth' : 'breadth'),
      }));
    }
    const before = f.size;
    const w = 1 + (t % 12);
    const wave = f.popWave(w, { wave: 1 + (t % 4) });
    if (wave.length > w) overWidth++;
    if (new Set(wave).size !== wave.length) dupNode++;
    if (f.size + wave.length !== before) leaked++;
    maxSeen = Math.max(maxSeen, wave.length);
  }
  eq('popWave NEVER returns more nodes than the requested width', overWidth, 0);
  eq('popWave NEVER returns the same node twice', dupNode, 0);
  eq('every popped node leaves the frontier exactly once', leaked, 0);
  ok('the stress actually exercised wide waves', maxSeen >= 8);
}

section('frontier/popWave: the per-branch quota can STARVE the wave');
{
  // quota = ceil(w / openBranches) + 1. With one fat branch and one thin one
  // the quota is 6 and the thin branch has 1 node, so 3 of 10 slots go unused
  // while 14 admissible nodes sit in the frontier.
  const f = new Frontier();
  for (let i = 0; i < 20; i++) f.admit(makeNode({ q: `fat branch question ${i} sierra`, sub: 'A', priority: 0.9 }));
  f.admit(makeNode({ q: 'the one lonely thin question tango', sub: 'B', priority: 0.9 }));
  const wave = f.popWave(10, { wave: 1 });
  bug('BUG-07', 'popWave under-fills the wave: 10 slots, 21 admissible nodes, 7 used',
    wave.length < 10 && f.size > 0,
    `frontier.mjs:159 (quota = ceil(w/branches)+1) — wave=${wave.length}/10, ${f.size} nodes still queued`);

  // The same frontier with the thin branch REMOVED runs a full wave: adding a
  // second, near-empty branch makes the run slower, not wider.
  const g = new Frontier();
  for (let i = 0; i < 20; i++) g.admit(makeNode({ q: `fat branch question ${i} sierra`, sub: 'A', priority: 0.9 }));
  eq('one branch alone fills all 10 slots', g.popWave(10, { wave: 1 }).length, 10);
}

section('frontier/popWave: the verification reserve');
{
  // reserveWanted = max(1, round(w*0.2)); at w=1 that rounds up to the WHOLE
  // wave, so a single verify node monopolises every wave until it is drained.
  const f = new Frontier();
  f.admit(makeNode({ q: 'verify this contested claim uniform', sub: 'A', kind: 'verify', priority: 0.16 }));
  for (let i = 0; i < 5; i++) f.admit(makeNode({ q: `urgent breadth question ${i} victor`, sub: 'A', priority: 1 }));
  const wave = f.popWave(1, { wave: 1 });
  bug('BUG-08', 'at --sub-agents 1 the verification reserve consumes 100% of the wave',
    wave.length === 1 && wave[0].kind === 'verify',
    'frontier.mjs:160-162 — max(1, round(1*0.2)) = 1 = the entire wave, so a priority-0.16 verify outranks five priority-1.0 nodes');

  const g = new Frontier();
  g.admit(makeNode({ q: 'verify this contested claim uniform', sub: 'A', kind: 'verify', priority: 0.16 }));
  for (let i = 0; i < 9; i++) g.admit(makeNode({ q: `ordinary widening question ${i} whiskey`, sub: 'A', priority: 0.99 }));
  const w10 = g.popWave(10, { wave: 1 });
  ok('at a sane width the reserve is a slice, not the wave', w10.filter(n => n.kind === 'verify').length === 1 && w10.length === 10);
}

section('frontier: bookkeeping growth');
{
  const f = new Frontier({ minPriority: 0.9 });
  for (let i = 0; i < 2000; i++) f.admit(makeNode({ q: `rejected candidate number ${i} xray`, sub: 's', priority: 0.1 }));
  bug('BUG-09', 'seen/rejected grow without any bound or eviction',
    f.seen.size === 2000 && f.rejected.length === 2000,
    `frontier.mjs:71-73 — after 2000 rejections: seen=${f.seen.size}, rejected=${f.rejected.length}, nodes=${f.size} (toJSON caps the SNAPSHOT at 50, the arrays themselves are unbounded)`);
  eq('toJSON caps the reported rejections at 50', f.toJSON().rejected.length, 50);
  eq('but reports the true total', f.toJSON().rejected_total, 2000);
}

// =========================================================================
// PART 2 — pool.mjs
// =========================================================================

section('pool/mapPool: degenerate concurrency (contract)');
const { mapPool } = await import('../../src/lib/pool.mjs');
{
  const items = [1, 2, 3, 4, 5];
  const idw = async (x) => x * 2;
  eq('concurrency 0 still runs everything', (await mapPool(items, 0, idw)).length, 5);
  eq('negative concurrency still runs everything', (await mapPool(items, -9, idw)).length, 5);
  eq('NaN concurrency still runs everything', (await mapPool(items, NaN, idw)).length, 5);
  eq('Infinity concurrency terminates', (await mapPool(items, Infinity, idw)).length, 5);
  eq('an empty item list returns an empty array', (await mapPool([], 4, idw)).length, 0);
  eq('a non-array items argument returns an empty array', (await mapPool(null, 4, idw)).length, 0);
  eq('results are positional', (await mapPool(items, 2, idw))[3].value, 8);
}
{
  const boom = async () => { throw Object.assign(new Error('always'), { code: 'X' }); };
  const r = await mapPool([1, 2, 3], 3, boom);
  ok('a worker that always throws never kills the pool', r.length === 3 && r.every(x => x.ok === false));
  eq('and the error is preserved', r[0].error.code, 'X');
}
{
  let inFlight = 0, peak = 0;
  await mapPool(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
  });
  ok('concurrency is really bounded', peak <= 4, `peak in-flight was ${peak}`);
}
{
  const r = await mapPool([1], 1, async () => undefined);
  ok('a worker resolving undefined is reported as ok:true with value undefined',
    r[0].ok === true && r[0].value === undefined);
}

// =========================================================================
// PART 3 — heuristics.mjs
// =========================================================================

section('heuristics: degenerate briefs');
const { heuristicPlan, keywordize } = await import('../../src/lib/ai/heuristics.mjs');
eq('keywordize of only stopwords is empty', keywordize('the a an of to in on'), '');
eq('keywordize of an empty string is empty', keywordize(''), '');
{
  const p = heuristicPlan({ question: '', goal: '', today: '2026-08-29' }, { maxQueries: 6 });
  const contentFree = p.queries.map(q => q.q.trim());
  bug('BUG-10', 'heuristicPlan on an EMPTY question emits generic, subject-free searches',
    p.queries.length > 0 && contentFree.includes('official documentation'),
    `heuristics.mjs:44-52 — core is "" and the template still fires: ${JSON.stringify(contentFree.slice(0, 3))} (each is a real, billed Brave request)`);
}
{
  const t0 = Date.now();
  const p = heuristicPlan({ question: 'x '.repeat(120_000), goal: 'g', today: '2026-08-29' }, { maxQueries: 6 });
  const ms = Date.now() - t0;
  ok('a 240k-char question does not hang the planner', ms < 3_000, `${ms}ms`);
  ok('and every emitted query respects the 380-char wire limit', p.queries.every(q => q.q.length <= 380));
}
{
  const p = heuristicPlan({ question: 'how do I cap concurrency in node' }, { maxQueries: 0 });
  bug('BUG-11', 'heuristicPlan with maxQueries 0 still emits one query',
    p.queries.length === 1,
    'heuristics.mjs:69 — the cap is checked AFTER the push, so 0 and 1 are the same budget');
}

// =========================================================================
// PART 4 — ledger.mjs
// =========================================================================

section('ledger/canonicalUrl (contract)');
const { Ledger, canonicalUrl } = await import('../../src/lib/ai/ledger.mjs');
eq('an unparseable url is returned verbatim, not dropped', canonicalUrl('not a url at all'), 'not a url at all');
eq('a non-string is empty', canonicalUrl(null), '');
eq('an empty string is empty', canonicalUrl('   '), '');
eq('the default https port is normalised away', canonicalUrl('https://a.com:443/x'), 'https://a.com/x');
eq('the default http port is normalised away', canonicalUrl('http://a.com:80/x'), 'http://a.com/x');
eq('a non-default port is preserved', canonicalUrl('https://a.com:8443/x'), 'https://a.com:8443/x');
eq('a bare host keeps its root slash', canonicalUrl('https://a.com'), 'https://a.com/');
ok('unicode hosts and paths do not throw', canonicalUrl('https://例え.jp/パス').startsWith('https://'));
ok('a 30k-char url is handled', canonicalUrl('https://a.com/' + 'p'.repeat(30_000)).length > 30_000);

section('ledger/canonicalUrl: dedupe merges things it should not');
bug('BUG-12', 'credentials embedded in a url survive canonicalisation and reach stdout + the LLM prompt',
  canonicalUrl('https://user:s3cr3t@a.com/x').includes('s3cr3t'),
  `ledger.mjs:20-26 — canonicalUrl('https://user:s3cr3t@a.com/x') = "${canonicalUrl('https://user:s3cr3t@a.com/x')}"; it is printed by sourcesText() and embedded in the synthesis prompt`);
bug('BUG-13', 'stripping `source`/`ref` merges genuinely different pages into one source',
  canonicalUrl('https://d.io/api?source=cli') === canonicalUrl('https://d.io/api?source=gui'),
  `ledger.mjs:13-14 — both → "${canonicalUrl('https://d.io/api?source=cli')}"; the second page's title is discarded`);
{
  // The condition here used to be `canonicalUrl(x) === canonicalUrl(x)` — the
  // same call on both sides, i.e. `s === s` for a function that returns a
  // string. It could not fail against ANY implementation, so BUG-14 was a
  // permanent, unfalsifiable marker. canonicalUrl() takes no base, so the
  // "across hosts" half is not expressible at that call site — but the merge it
  // causes IS observable one level up, in the Ledger, with no production
  // signature touched. Two searches on two different sites each return
  // /docs/install; the ledger keys its source index on canonicalUrl, so they
  // collapse into ONE numbered source and the second page's title is discarded.
  // What would make this fail: any canonicalUrl that refuses to treat a
  // host-less url as a citable identity (returning '' for it, as it already
  // does for a blank string, makes #indexSource return null and the size 0),
  // or a Ledger that keys relative urls per row.
  const l14 = new Ledger();
  l14.addSuccess(1, { id: 'r14a', q: 'install docs on site A', sub: 's1' },
    { provider: 'brave', data: { results: [{ url: '/docs/install', title: 'Site A — Install' }] } });
  l14.addSuccess(2, { id: 'r14b', q: 'install docs on site B', sub: 's2' },
    { provider: 'brave', data: { results: [{ url: '/docs/install', title: 'Site B — Install' }] } });
  bug('BUG-14', 'a RELATIVE url falls through the catch and is kept verbatim, with no host — so the same /path found on two different sites merges into ONE source entry',
    canonicalUrl('/docs/install') === '/docs/install'
      && l14.sourceIndex.size === 1
      && l14.rows[0].results[0].n === 1 && l14.rows[1].results[0].n === 1,
    `ledger.mjs:27-29 returns the raw string; ledger.mjs:100-106 then keys the source index on it — ${l14.sourceIndex.size} source(s) for two different pages, both cited as [${l14.rows[0].results[0].n}], surviving title "${[...l14.sourceIndex.values()][0].title}"`);
}
bug('BUG-15', 'canonicalUrl is not idempotent on doubled slashes',
  canonicalUrl(canonicalUrl('https://a.com/x//')) !== canonicalUrl('https://a.com/x//'),
  `ledger.mjs:25 strips ONE trailing slash: "https://a.com/x//" → "${canonicalUrl('https://a.com/x//')}" → "${canonicalUrl(canonicalUrl('https://a.com/x//'))}"`);
ok('a trailing slash before a query string is NOT normalised (documented gap)',
  canonicalUrl('https://a.com/x/?q=1') !== canonicalUrl('https://a.com/x?q=1'));

section('ledger/addSuccess + addFailure: malformed envelopes');
{
  const l = new Ledger();
  let threw = null;
  try { l.addSuccess(1, { id: 'q1', q: 'x', sub: 's' }, undefined); } catch (e) { threw = e; }
  bug('BUG-16', 'addSuccess guards `envelope.data` but then dereferences `envelope.provider` unguarded',
    threw !== null,
    `ledger.mjs:58 does \`(envelope && envelope.data) || {}\`, ledger.mjs:76 does \`envelope.provider\` — ${threw && threw.message}`);

  let threw2 = null;
  try { l.addSuccess(1, { id: 'q2', q: 'y', sub: 's' }, { provider: 'brave', data: { results: [null] } }); } catch (e) { threw2 = e; }
  bug('BUG-17', 'a null entry inside data.results throws and aborts the whole wave accounting',
    threw2 !== null,
    `ledger.mjs:61 — canonicalUrl(r.url) on a null result: ${threw2 && threw2.message}`);

  ok('a completely empty envelope object is tolerated', (() => {
    try { l.addSuccess(1, { id: 'q3', q: 'z', sub: 's' }, {}); return true; } catch { return false; }
  })());
  ok('data.results as a non-array is tolerated', (() => {
    try { l.addSuccess(1, { id: 'q4', q: 'w', sub: 's' }, { provider: 'b', data: { results: 'nope' } }); return true; } catch { return false; }
  })());
  ok('addFailure with a bare string error does not throw', (() => {
    try { l.addFailure(1, { id: 'q5', q: 'v', sub: 's' }, 'boom'); return true; } catch { return false; }
  })());
  eq('and it classifies as a generic Error', l.rows.find(r => r.id === 'q5').error.code, 'Error');
  ok('addFailure with undefined does not throw', (() => {
    try { l.addFailure(1, { id: 'q6', q: 'u', sub: 's' }, undefined); return true; } catch { return false; }
  })());
}
{
  const l = new Ledger();
  l.addSuccess(1, { id: 'q1', q: 'x', sub: 's' }, {
    provider: 'brave', data: { results: [{ title: 'no url here', content: 'body' }] },
  });
  bug('BUG-18', 'a result with no url gets citation number `null`, which is printed to the model',
    l.rows[0].results[0].n === null && l.digest().includes('[null]'),
    'ledger.mjs:103 returns null from #indexSource and ledger.mjs:183 interpolates it — the synthesis prompt receives the marker "[null]"');
}

section('ledger/digest: truncation at the border');
{
  const l = new Ledger();
  l.addSuccess(1, { id: 'q1', q: 'huge', sub: 's' }, {
    provider: 'brave', data: { results: [{ url: 'https://c.com/1', title: 'C', content: 'z'.repeat(50_000) }] },
  });
  l.addSuccess(1, { id: 'q2', q: 'small', sub: 's' }, {
    provider: 'brave', data: { results: [{ url: 'https://d.com/1', title: 'D', content: 'tiny' }] },
  });
  const d = l.digest({ perResult: 40_000, maxChars: 50 });
  bug('BUG-19', 'when maxChars is smaller than the FIRST block the digest contains zero evidence',
    d.includes('evidence truncated') && !d.includes('###'),
    `ledger.mjs:188-191 breaks before pushing anything — the model receives only: ${JSON.stringify(d.trim().slice(0, 120))}`);
  ok('a normal ceiling keeps at least the first block',
    l.digest({ perResult: 200, maxChars: 5_000 }).includes('### [q1]'));
  eq('sinceRound beyond every row yields the empty marker', l.digest({ sinceRound: 99 }), '(no evidence gathered)');
  ok('sinceRound 0 keeps everything', l.digest({ perResult: 50, maxChars: 100_000 }).includes('### [q2]'));
  ok('an empty ledger yields the empty marker', new Ledger().digest() === '(no evidence gathered)');
}

section('ledger/tableMarkdown: the --ledger table (Q4)');
{
  const l = new Ledger();
  l.addSuccess(1, { id: 'q1', q: 'x', sub: 'sq1' }, {
    provider: 'brave', data: { results: [{ url: 'https://a.com/1', title: 'Redis | Docs | Cluster', content: 'c' }] },
  });
  const lines = l.tableMarkdown().split('\n');
  const headerCols = lines[0].split('|').length;
  const rowCols = lines[2].split('|').length;
  bug('BUG-20', 'a `|` in a source title breaks the markdown table (extra columns)',
    rowCols !== headerCols,
    `ledger.mjs:212-217 does not escape the title — header has ${headerCols - 2} columns, the row has ${rowCols - 2}. render.mjs:45 DOES escape pipes in the rejected-candidate table, so the omission here is an oversight, not a policy`);

  const l2 = new Ledger();
  l2.addSuccess(1, { id: 'q1', q: 'x', sub: 'sq1' }, {
    provider: 'brave', data: { results: [{ url: 'https://a.com/1', title: 'Line one\nLine two', content: 'c' }] },
  });
  bug('BUG-21', 'a newline in a source title splits one ledger row into two',
    l2.tableMarkdown().split('\n').length === 4,
    `ledger.mjs:236-239 (trunc) does not collapse newlines — the table gained a phantom row: ${JSON.stringify(l2.tableMarkdown().split('\n')[3])}`);

  const l3 = new Ledger();
  l3.addSuccess(1, { id: 'q1', q: 'x', sub: 'a|b' }, {
    provider: 'brave', data: { results: [{ url: 'https://a.com/1', title: 'T', content: 'c' }] },
  });
  bug('BUG-22', 'a `|` in a sub-question id breaks the table too',
    l3.tableMarkdown().split('\n')[2].split('|').length !== headerCols,
    'ledger.mjs:216 — `sub` is interpolated raw, and sub ids come from the LLM plan');

  ok('a >60-char title is truncated with an ellipsis',
    (() => {
      const l4 = new Ledger();
      l4.addSuccess(1, { id: 'q1', q: 'x', sub: 's' }, {
        provider: 'brave', data: { results: [{ url: 'https://a.com/1', title: 'T'.repeat(200), content: 'c' }] },
      });
      return l4.tableMarkdown().includes('…');
    })());
}

section('ledger/stats, sourcesText, newSourcesInRound');
{
  const l = new Ledger();
  l.addSuccess(1, { id: 'q1', q: 'a', sub: 's' }, {
    provider: 'brave', usage: { credits: 1 },
    data: { results: [{ url: 'https://a.com/1', title: 'A', content: 'x' }] },
  });
  l.addSuccess(2, { id: 'q2', q: 'b', sub: 's' }, {
    provider: 'brave', usage: { credits: 1 },
    data: { results: [{ url: 'https://a.com/1', title: 'A again', content: 'x' }, { url: 'https://b.com/1', title: 'B', content: 'y' }] },
  });
  l.addFailure(2, { id: 'q3', q: 'c', sub: 's' }, new Error('nope'));
  eq('sources are deduped across rounds', l.stats().sources, 2);
  eq('credits sum only over rows that carry them', l.stats().credits, 2);
  eq('failures are counted, not dropped', l.stats().failed, 1);
  eq('newSourcesInRound(2) sees exactly the one new url', l.newSourcesInRound(2), 1);
  eq('newSourcesInRound(1) sees the first url', l.newSourcesInRound(1), 1);
  eq('newSourcesInRound beyond the last round is 0', l.newSourcesInRound(9), 0);
  ok('the source index keeps the FIRST title it saw, never the better later one',
    l.sourcesText().includes('[1] A —') && !l.sourcesText().includes('A again'));
  bug('BUG-23', 'newSourcesInRound() is dead code — the orchestrator measures saturation a different way',
    true,
    'ledger.mjs:118 is defined and never called: `grep -rn newSourcesInRound src bin test` matches only its own definition. orchestrator.mjs:300/316 uses `ledger.stats().sources` deltas instead, and the two disagree for results with no url');
  ok('an empty ledger has a placeholder source list', new Ledger().sourcesText() === '(no sources retrieved)');
}

// =========================================================================
// PART 5 — the full orchestrator loop, offline
// =========================================================================

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(body) };
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
// Distinct query -> distinct urls. (smoke.mjs slices the encoded query to 20
// chars, which makes long similar queries collide and fakes saturation.)
function braveHit(query, i) {
  return {
    url: `https://example.com/${hash(query)}/${i}`,
    title: `Result ${i} for ${query}`,
    description: `Body text for ${query} number ${i}. `.repeat(6),
    extra_snippets: [`Extra excerpt ${i}.`],
    page_age: '2026-07-01T00:00:00',
    age: 'July 1, 2026',
  };
}

let orScript = [];
let orCalls = [];
let braveCalls = [];
let braveBehavior = () => ({ status: 200 });
let orDefault = null;

function orChat(content) {
  return () => jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { total_tokens: 100, cost: 0.0001 },
    model: 'deepseek/deepseek-v4-pro',
  });
}

function installFetchStub() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('openrouter') && u.endsWith('/key')) {
      return jsonResponse(200, { data: { label: 'adv', limit: null, usage: 0, is_free_tier: false } });
    }
    if (u.includes('openrouter') && u.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      orCalls.push(body);
      const next = orScript.shift() || orDefault;
      if (!next) return jsonResponse(503, { error: { message: 'stub exhausted' } });
      return next(body);
    }
    if (u.includes('brave')) {
      const params = new URL(u).searchParams;
      const query = params.get('q') || '';
      braveCalls.push({ query, count: params.get('count'), params });
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

const ANALYSIS_DONE = JSON.stringify({
  resolved: true, confidence: 'high', coverage: [], open_points: [],
  next_queries: [], branches_to_close: [], saturation: false, stop_reason: 'criteria met',
});

function planJson(queries, subs = [{ id: 'sq1', question: 'core', why: 'core' }]) {
  return JSON.stringify({
    restated_objective: 'objective', sub_questions: subs, queries,
    success_criteria: ['a primary source confirms it'],
  });
}
const PLAN_1Q = planJson([{ id: 'q1', q: 'alpha seed question one', sub: 'sq1', category: 'official-docs', priority: 0.9 }]);
const PLAN_10Q = planJson(Array.from({ length: 10 }, (_, i) => ({
  id: `q${i + 1}`, q: `seed question topic alpha ${i + 1}`, sub: 'sq1', category: 'community', priority: 0.9,
})));

// Safety net so an under-provisioned script never triggers OpenRouter's retry
// ladder (which would add seconds of backoff and prove nothing).
function autoReply(body) {
  const name = body.response_format && body.response_format.json_schema && body.response_format.json_schema.name;
  if (name === 'surf_ai_plan') return orChat(PLAN_1Q)(body);
  if (name === 'surf_ai_analysis') return orChat(ANALYSIS_DONE)(body);
  return orChat('# Answer\nauto-generated stub answer [1].')(body);
}
orDefault = autoReply;

installFetchStub();
const { runSurfAi } = await import('../../src/lib/ai/orchestrator.mjs');
const { renderMarkdown } = await import('../../src/lib/ai/render.mjs');

const NOCACHE = { 'no-cache': true };
function reset(script) { orScript = script || []; orCalls = []; braveCalls = []; }
const run = (ctx, opts, label, ms = 25_000) => withTimeout(runSurfAi(ctx, opts), ms, label);

section('orchestrator: knob coercion (Q: subAgents/maxQueries/maxDepth/maxRounds out of range)');
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  const r = await run({ question: 'knobs a' }, { mode: 'normal', subAgents: 99, flags: NOCACHE }, 'subAgents 99');
  eq('--sub-agents above the ceiling clamps to 20', r.diagnostics.subAgents, 20);
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  const r = await run({ question: 'knobs b' }, { mode: 'normal', subAgents: -4, flags: NOCACHE }, 'subAgents -4');
  eq('a negative --sub-agents clamps to 1', r.diagnostics.subAgents, 1);
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  const r = await run({ question: 'knobs c' }, { mode: 'normal', subAgents: 0, maxDepth: 0, maxQueries: 0, flags: NOCACHE }, 'zeros');
  bug('BUG-24', 'a ZERO knob is silently replaced by the default instead of being rejected',
    r.diagnostics.subAgents === 10 && r.diagnostics.maxDepth === 2 && r.diagnostics.maxQueries === 10,
    `orchestrator.mjs:122/128/134 use \`Number(x) || default\`, so 0 is falsy — asked for subAgents=0/maxDepth=0/maxQueries=0, got ${r.diagnostics.subAgents}/${r.diagnostics.maxDepth}/${r.diagnostics.maxQueries}. A library caller gets the opposite of what it asked for, with no warning`);
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  const r = await run({ question: 'knobs d' }, { mode: 'normal', maxQueries: 2, subAgents: 8, flags: NOCACHE }, 'maxQueries<subAgents');
  eq('maxQueries below subAgents is lifted to subAgents (documented)', r.diagnostics.maxQueries, 8);
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  const r = await run({ question: 'knobs e' }, { mode: 'unlimit', maxRounds: 1e9, flags: NOCACHE }, 'maxRounds 1e9');
  eq('maxRounds is hard-clamped to 50 — the loop is structurally bounded', r.diagnostics.maxRounds, 50);
}

section('orchestrator: --search-mode really reaches the Brave adapter');
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  await run({ question: 'sm default' }, { mode: 'normal', flags: NOCACHE }, 'no search-mode');
  eq('no --search-mode and no --max sends the tier default count', braveCalls[0].count, '5');
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  await run({ question: 'sm slow' }, { mode: 'normal', searchMode: 'slow', flags: NOCACHE }, 'search-mode slow');
  eq('--search-mode slow reaches the wire as count=20', braveCalls[0].count, '20');
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  await run({ question: 'sm fast max' }, { mode: 'normal', searchMode: 'slow', max: 3, flags: NOCACHE }, 'search-mode + max');
  eq('an explicit --max still beats --search-mode', braveCalls[0].count, '3');
}
{
  reset([orChat(PLAN_1Q), orChat('# A\nx [1].')]);
  await run({ question: 'sm normal' }, { mode: 'normal', searchMode: 'normal', flags: NOCACHE }, 'search-mode normal');
  bug('BUG-25', 'passing --search-mode normal changes the request vs omitting it',
    braveCalls[0].count === '10',
    `orchestrator.mjs:519 — omitting --search-mode sends max=${5} (the run-tier default), while the nominally identical --search-mode normal sends no max and Brave defaults to count=${braveCalls[0].count}`);
}

section('orchestrator: the frontier can be left holding queries nobody mentions (Q5)');
{
  reset([orChat(PLAN_10Q), orChat('# Answer\nDone [1].')]);
  const r = await run({ question: 'wide plan narrow wave' }, { mode: 'normal', subAgents: 3, flags: NOCACHE }, 'normal 10 queries / 3 agents');
  eq('only 3 of the 10 planned queries actually ran', braveCalls.length, 3);
  eq('7 stay queued', r.frontier.pending, 7);
  eq('and the stop reason claims the wave was by design', r.stop_reason, 'normal mode: a single wave by design');
  const lean = renderMarkdown(r);
  const full = renderMarkdown(r, { ledger: true });
  bug('BUG-26', 'the DEFAULT output never says that 7 of 10 planned queries were never run',
    !lean.includes('still queued') && full.includes('7 queries still queued'),
    'render.mjs:33-39 puts the "Frontier: N queries still queued" line behind --ledger, so the lean output an agent actually reads reports 3 queries, 1 wave and a clean stop — and nothing about the 70% of the plan that was dropped');
  ok('the count IS present in the machine-readable result', r.frontier.pending === 7);
}
{
  // The same hole in unlimit mode: the analyst declares victory while nodes wait.
  const ANALYSIS_RESOLVED_EARLY = JSON.stringify({
    resolved: true, confidence: 'high', coverage: [], open_points: [],
    next_queries: [], branches_to_close: [], saturation: false, stop_reason: 'good enough',
  });
  reset([orChat(PLAN_10Q), orChat(ANALYSIS_RESOLVED_EARLY), orChat('# Answer\nResolved [1].')]);
  const r = await run({ question: 'resolved early' }, { mode: 'unlimit', subAgents: 2, maxRounds: 5, flags: NOCACHE }, 'resolved with pending');
  bug('BUG-26b', 'a run can report "resolved" with 8 unexplored queries and never mention them',
    r.frontier.pending === 8 && /good enough/.test(r.stop_reason) && !renderMarkdown(r).includes('still queued'),
    `orchestrator.mjs:381-385 breaks on analysis.resolved without consulting frontier.size — pending=${r.frontier.pending}, stop_reason="${r.stop_reason}"`);
}

section('orchestrator: a plan of content-free queries produces a silent zero-wave run');
{
  const PLAN_STOPWORDS = planJson([
    { id: 's1', q: 'a an of', sub: 'sq1', category: 'community', priority: 0.9 },
    { id: 's2', q: 'to in on', sub: 'sq1', category: 'community', priority: 0.9 },
  ]);
  reset([orChat(PLAN_STOPWORDS)]);
  const r = await run({ question: 'stopword plan' }, { mode: 'normal', flags: NOCACHE }, 'stopword plan');
  eq('not one search was attempted', braveCalls.length, 0);
  eq('and zero waves ran', r.rounds, 0);
  bug('BUG-27', 'zero waves ran, yet the run reports "completed the planned wave"',
    r.stop_reason === 'completed the planned wave' && r.rounds === 0,
    'orchestrator.mjs:269 initialises stopReason to "completed the planned wave"; when the while-loop never enters (frontier empty after admission) nothing overwrites it. The frontier rejected both queries, and the answer is the "Every search failed" report with an EMPTY attempt list');
  bug('BUG-27b', 'the no-evidence report claims every search failed when none was ever issued',
    r.answer.includes('Every search failed') && r.ledger.rows.length === 0,
    'orchestrator.mjs:550-557 — "What was attempted" iterates ledger.rows, which is empty, so the agent is told searching failed rather than that its plan was rejected');
}

section('orchestrator: malformed analyst replies (unlimit)');
{
  // A reply that is valid JSON but falsy: `false`, `0`, `""` all pass
  // openrouter.mjs:432 (`value == null`) and then collapse to null here.
  reset([orChat(PLAN_1Q), orChat('false'), orChat('# A\nx [1].')]);
  let err = null;
  try {
    await run({ question: 'falsy analysis' }, { mode: 'unlimit', maxRounds: 4, flags: NOCACHE }, 'falsy analysis');
  } catch (e) { err = e; }
  bug('BUG-28', 'a falsy-but-valid analyst reply (false / 0 / "") CRASHES the run after the searches were paid for',
    err !== null && err.code !== 'TestTimeout' && /open_points/.test(String(err && err.message)),
    `orchestrator.mjs:366 does \`analysis = r.value || null\`; :393 guards next_queries with Array.isArray, but :408 dereferences analysis.open_points unguarded — ${err && err.message}`);
}
{
  const ANALYSIS_BAD_BRANCHES = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: [],
    next_queries: [], branches_to_close: 5, saturation: false, stop_reason: 'x',
  });
  reset([orChat(PLAN_1Q), orChat(ANALYSIS_BAD_BRANCHES), orChat('# A\nx [1].')]);
  let err = null;
  try {
    await run({ question: 'bad branches' }, { mode: 'unlimit', maxRounds: 4, flags: NOCACHE }, 'non-iterable branches_to_close');
  } catch (e) { err = e; }
  bug('BUG-29', 'a non-iterable branches_to_close throws TypeError and kills the run',
    err !== null && err.code !== 'TestTimeout' && /iterable/.test(String(err && err.message)),
    `orchestrator.mjs:376 \`for (const sub of (analysis && analysis.branches_to_close) || [])\` — 5 is truthy, so the || guard does not fire — ${err && err.message}`);
}
{
  const ANALYSIS_STRING_BRANCHES = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: [],
    next_queries: [], branches_to_close: 'sq1', saturation: false, stop_reason: 'x',
  });
  reset([orChat(PLAN_1Q), orChat(ANALYSIS_STRING_BRANCHES), orChat('# A\nx [1].')]);
  const r = await run({ question: 'string branches' }, { mode: 'unlimit', maxRounds: 4, flags: NOCACHE }, 'string branches_to_close');
  bug('BUG-30', 'a STRING branches_to_close is iterated character by character, closing phantom branches',
    JSON.stringify(r.frontier.closed_branches) === JSON.stringify(['s', 'q', '1']),
    `orchestrator.mjs:376 — "sq1" iterated as characters, closed_branches = ${JSON.stringify(r.frontier.closed_branches)}. Each of those ids is now permanently un-admittable`);
}
{
  const ANALYSIS_GHOST_BRANCH = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: [],
    next_queries: [{ id: 'g1', q: 'ghost branch follow up query', sub: 'sqGHOST', category: 'community', priority: 0.9, kind: 'depth', parent: 'q1' }],
    branches_to_close: ['sqGHOST'], saturation: false, stop_reason: 'x',
  });
  reset([orChat(PLAN_1Q), orChat(ANALYSIS_GHOST_BRANCH), orChat('# A\nx [1].')]);
  const r = await run({ question: 'ghost branch' }, { mode: 'unlimit', maxRounds: 4, flags: NOCACHE }, 'ghost branch');
  ok('closing a branch that does not exist yet still blocks its future queries (consistent with BUG-06)',
    r.frontier.rejected.some(x => /already closed/.test(x.reason)),
    JSON.stringify(r.frontier.rejected));
}

section('orchestrator: parent lineage is looked up in the CURRENT wave only');
{
  // maxDepth 1. Every follow-up names a parent from an EARLIER wave, so byId
  // misses it and the depth resets to 1 instead of parent.depth + 1.
  const a1 = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: ['deeper'],
    next_queries: [{ id: 'd2', q: 'level two descent question bravo', sub: 'sq1', category: 'community', priority: 0.9, kind: 'depth', parent: 'q1' }],
    branches_to_close: [], saturation: false, stop_reason: 'go deeper',
  });
  const a2 = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: ['deeper'],
    next_queries: [
      // honest lineage -> depth 2 -> must be refused at maxDepth 1
      { id: 'd3', q: 'level three honest descent charlie', sub: 'sq1', category: 'community', priority: 0.9, kind: 'depth', parent: 'd2' },
      // stale ancestor -> byId miss -> depth 1 -> admitted
      { id: 'd3b', q: 'level three stale ancestor delta', sub: 'sq1', category: 'community', priority: 0.9, kind: 'depth', parent: 'q1' },
    ],
    branches_to_close: [], saturation: false, stop_reason: 'go deeper',
  });
  const a3 = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: ['deeper'],
    next_queries: [{ id: 'd4', q: 'level four stale ancestor echo', sub: 'sq1', category: 'community', priority: 0.9, kind: 'depth', parent: 'd2' }],
    branches_to_close: [], saturation: false, stop_reason: 'go deeper',
  });
  reset([orChat(PLAN_1Q), orChat(a1), orChat(a2), orChat(a3), orChat(ANALYSIS_DONE), orChat('# A\nx [1].')]);
  const r = await run({ question: 'depth cap evasion' }, { mode: 'unlimit', maxRounds: 6, maxDepth: 1, subAgents: 4, flags: NOCACHE }, 'depth cap evasion');
  const depths = r.ledger.rows.map(x => x.depth);
  const honestRejected = r.frontier.rejected.some(x => /depth cap/.test(x.reason));
  ok('the HONEST deep follow-up is correctly refused at the cap', honestRejected, JSON.stringify(r.frontier.rejected));
  bug('BUG-31', 'naming a parent from an earlier wave resets depth to 1 and defeats --max-depth',
    r.rounds >= 4 && depths.filter(d => d === 1).length >= 3 && Math.max(...depths) === 1,
    `orchestrator.mjs:392 builds byId from THIS wave only, so orchestrator.mjs:399 falls to \`depth = 1\` — with maxDepth=1 the run still descended ${r.rounds} links (recorded depths ${JSON.stringify(depths)}). Every node also loses its parent pointer, so the ledger tree is wrong: parents = ${JSON.stringify(r.ledger.rows.map(x => x.parent))}`);
}

section('orchestrator: the analyst can reuse a query id');
{
  const a1 = JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: [],
    next_queries: [{ id: 'q1', q: 'a completely different second question', sub: 'sq1', category: 'community', priority: 0.9, kind: 'breadth' }],
    branches_to_close: [], saturation: false, stop_reason: 'more',
  });
  reset([orChat(PLAN_1Q), orChat(a1), orChat(ANALYSIS_DONE), orChat('# A\nx [1].')]);
  const r = await run({ question: 'id collision' }, { mode: 'unlimit', maxRounds: 4, flags: NOCACHE }, 'id collision');
  const ids = r.ledger.rows.map(x => x.id);
  bug('BUG-32', 'a reused query id is accepted, so the ledger has two different queries under one id',
    ids.filter(i => i === 'q1').length === 2,
    `frontier.mjs:50 takes \`id\` verbatim with no uniqueness check — ledger ids ${JSON.stringify(ids)}; the --ledger table, the [id] headers in the digest and the byId parent map all become ambiguous`);
}

section('orchestrator: the loop always terminates (Q3)');
{
  // The analyst is never satisfied and always proposes a brand-new query.
  // If anything could spin forever, this is the shape that does it.
  const N = 50;
  const script = [orChat(PLAN_1Q)];
  for (let i = 0; i < N + 5; i++) {
    script.push(orChat(JSON.stringify({
      resolved: false, confidence: 'low', coverage: [], open_points: ['never done'],
      next_queries: [
        { id: `n${i}a`, q: `never ending fresh question number ${i} foxtrot`, sub: 'sq1', category: 'community', priority: 0.9, kind: 'breadth' },
        { id: `n${i}b`, q: `never ending second fresh question ${i} golf`, sub: 'sq1', category: 'community', priority: 0.9, kind: 'breadth' },
      ],
      branches_to_close: [], saturation: false, stop_reason: 'more',
    })));
  }
  script.push(orChat('# A\nbounded [1].'));
  reset(script);
  orDefault = null; // any extra call would mean the loop overran maxRounds
  const t0 = Date.now();
  let r = null, err = null;
  try {
    r = await run({ question: 'never converge' }, { mode: 'unlimit', maxRounds: 1e9, subAgents: 1, flags: NOCACHE }, 'non-convergent analyst', 40_000);
  } catch (e) { err = e; }
  orDefault = autoReply;
  ok('a permanently unsatisfied analyst still terminates', err === null, err && err.message);
  eq('and it stops exactly at the 50-wave clamp', r && r.rounds, 50);
  ok('the stop reason names the cap', r && /wave cap \(50\)/.test(r.stop_reason), r && r.stop_reason);
  ok('it finished quickly', Date.now() - t0 < 30_000, `${Date.now() - t0}ms`);
  bug('BUG-33', 'the 50-wave ceiling is the ONLY thing that stops a non-convergent analyst, and the frontier is still full at the end',
    r && r.frontier.pending > 0,
    `orchestrator.mjs:272 — after 50 waves the frontier still holds ${r && r.frontier.pending} node(s); the run is bounded (no infinite loop) but it burned 50 Brave requests and 49 LLM calls with no convergence signal of its own`);
}

section('orchestrator: every search failing');
{
  reset([orChat(PLAN_10Q)]);
  braveBehavior = () => ({ status: 500 });
  const r = await run({ question: 'total outage' }, { mode: 'normal', subAgents: 10, flags: NOCACHE }, 'all searches fail');
  braveBehavior = () => ({ status: 200 });
  eq('every query is recorded as a failed row', r.stats.failed, 10);
  eq('nothing was retrieved', r.stats.sources, 0);
  ok('the no-evidence report is emitted, not a synthesis', r.answer.includes('No sources retrieved'));
  ok('and no LLM token was spent on synthesising nothing', orCalls.length === 1);
  eq('the frontier is genuinely empty here', r.frontier.pending, 0);
}

section('orchestrator: a wave failure permanently burns the query');
{
  // Node 1 fails with a transient 500; it is already out of the frontier and
  // its key is already in `seen`, so it can never be retried or re-proposed.
  reset([orChat(PLAN_1Q), orChat(JSON.stringify({
    resolved: false, confidence: 'low', coverage: [], open_points: ['retry it'],
    next_queries: [{ id: 'r1', q: 'alpha seed question one', sub: 'sq1', category: 'official-docs', priority: 1, kind: 'depth', parent: 'q1' }],
    branches_to_close: [], saturation: false, stop_reason: 'retry',
  })), orChat('# A\nx.')]);
  braveBehavior = (_b, n) => (n === 1 ? { status: 500 } : { status: 200 });
  const r = await run({ question: 'transient failure' }, { mode: 'unlimit', maxRounds: 4, flags: NOCACHE }, 'transient failure retry');
  braveBehavior = () => ({ status: 200 });
  bug('BUG-34', 'a query whose search FAILED can never be retried — popWave removed it and `seen` blocks re-proposal',
    r.ledger.rows.filter(x => !x.ok).length === 1 && r.frontier.rejected.some(x => /duplicate/.test(x.reason)),
    'frontier.mjs:201 drops popped nodes from this.nodes and frontier.mjs:101 keeps the key in `seen`; orchestrator.mjs:311 only marks node.status = "failed" and never re-admits. The analyst asking for the identical query again is refused as a "duplicate of a query already proposed" even though it never produced a single result');
}

// ---------------------------------------------------------------- summary ---

process.stdout.write(`\n${passed} contract assertion(s) passed, ${failures.length} failed\n`);
if (failures.length) for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);

process.stdout.write(`\n${bugs.length} DEFECT(S) CONFIRMED:\n`);
for (const b of bugs) process.stdout.write(`  ☢ ${b.id} — ${b.name}\n`);
if (stale.length) {
  process.stdout.write(`\n${stale.length} defect assertion(s) no longer reproduce (a fix probably landed — flip them):\n`);
  for (const s of stale) process.stdout.write(`  ○ ${s}\n`);
}

// Confirmed defects are the POINT of this suite; they never fail the run.
// Only a broken contract assertion does.
process.stdout.write(failures.length ? '\nloop-frontier: CONTRACT BROKEN\n' : '\nloop-frontier-ok\n');
process.exit(failures.length ? 1 : 0);
