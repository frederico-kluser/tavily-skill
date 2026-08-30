#!/usr/bin/env node
// Adversarial suite: the library API surface, key discovery, and the installer.
//
// Targets: src/index.mjs, src/lib/api/search.mjs, src/env.mjs,
//          src/lib/harness-install.mjs, src/install/*.mjs, src/lib/check-surf-skill.mjs
//
// SAFETY — read before editing:
//   * NO NETWORK. globalThis.fetch is stubbed before anything can dispatch, and
//     SURF_BRAVE_API_BASE points at an unroutable host as a second belt.
//   * NO REAL $HOME. The suite re-execs itself with HOME (and USERPROFILE) in a
//     throwaway directory, and the child REFUSES to run if os.homedir() is not
//     that directory. The installer creates symlinks in ~/.claude/skills and
//     friends; running it against a real home would clobber the user's skills.
//   * NO REAL CLI. The check-surf-skill section shells out to
//     `surf-research-skill`; PATH is replaced with a fixture dir for the whole
//     section so the machine's real install is never reached.
//
// Two verdict channels, on purpose:
//   ok()/eq()  — behaviour that must hold. A failure here fails the run.
//   bug()      — a defect this suite REPRODUCES. Reported, counted, and printed
//                as a checklist, but it never fails the run: the fixing wave
//                flips each one to "fixed" and only then does it start guarding.
//
// Run: node ./test/adversarial/lib-install.mjs

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync,
  existsSync, readlinkSync, lstatSync, chmodSync, statSync, readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');

// ------------------------------------------------------------- re-exec ---

if (!process.env.SURF_ADV_TEST_CHILD) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'surf-adv-home-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_ADV_TEST_CHILD: '1',
      SURF_ADV_REAL_HOME: process.env.HOME || '',
      SURF_QUIET: '1',
      SURF_NO_RATE_LIMIT: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      // Keep the machine's key material out of discovery.
      BRAVE_API_KEY: '', BRAVE_API_KEYS: '',
      OPENROUTER_API_KEY: '', OPENROUTER_API_KEYS: '',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

// ------------------------------------------------- child safety gate ---

const HOME = process.env.HOME;
const REAL_HOME = process.env.SURF_ADV_REAL_HOME;
function refuse(why) {
  process.stderr.write(`REFUSING TO RUN: ${why}\n`);
  process.exit(1);
}
if (!HOME) refuse('HOME is not set — os.homedir() would fall back to /etc/passwd');
if (!HOME.startsWith(os.tmpdir())) refuse(`HOME (${HOME}) is not under ${os.tmpdir()}`);
if (REAL_HOME && path.resolve(HOME) === path.resolve(REAL_HOME)) refuse('HOME is the real home');
if (path.resolve(os.homedir()) !== path.resolve(HOME)) {
  refuse(`os.homedir() (${os.homedir()}) != HOME (${HOME}) — the installer would write to the wrong home`);
}

// Belt #2: no request may leave this process.
let fetchCalls = [];
let nextResponse = () => ({ status: 200, body: { web: { results: [] }, query: {} } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  fetchCalls.push({ url: u, headers: (init && init.headers) || {} });
  const r = nextResponse(u);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new Map(Object.entries(r.headers || {})),
    text: async () => JSON.stringify(r.body),
  };
};
const wireQueries = () => fetchCalls.map(c => c.url.searchParams.get('q')).filter(Boolean);

// ----------------------------------------------------------- harness ---

let passed = 0;
const failures = [];
const bugs = [];
const fixed = [];

function ok(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); process.stdout.write(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** A defect this suite reproduces. `present` true = the bug is still live. */
function bug(id, name, present, detail) {
  if (present) { bugs.push({ id, name, detail }); process.stdout.write(`  ⚠ BUG ${id}: ${name}${detail ? ' — ' + detail : ''}\n`); }
  else { fixed.push(id); passed++; process.stdout.write(`  ✓ FIXED ${id}: ${name}\n`); }
}
function section(t) { process.stdout.write(`\n${t}\n`); }
async function rejects(fn, code) {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, code: e.code, name: e.name, message: e.message, error: e }; }
}
/**
 * Like rejects(), but keeps the resolved value too: { resolved, value, error }.
 *
 * Use it wherever a bug() says "this RESOLVES when it should reject". The fix
 * for such a bug is to make it reject, and a bare `await` would then be an
 * unhandled rejection that kills the process — taking every other assertion in
 * this file, and the whole bug ledger, with it. A bug() has to be able to
 * outlive its own fix, otherwise it blocks the fix.
 */
async function settle(fn) {
  try { return { resolved: true, value: await fn(), error: null }; }
  catch (error) { return { resolved: false, value: undefined, error }; }
}
/** lstat that answers "not there" instead of throwing ENOENT. */
function lstatOrNull(p) { try { return lstatSync(p); } catch { return null; } }

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'surf-adv-box-'));
let boxN = 0;
function box(label) {
  const d = path.join(SANDBOX, `${String(++boxN).padStart(2, '0')}-${label}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function fakePkg(dir, name = 'pkg') {
  const p = path.join(dir, name);
  mkdirSync(path.join(p, 'skills', 'surf-plan-agent-skill'), { recursive: true });
  writeFileSync(path.join(p, 'SKILL.md'), '# root skill\n');
  writeFileSync(path.join(p, 'skills', 'surf-plan-agent-skill', 'SKILL.md'), '# plan skill\n');
  return p;
}
function clearKeyEnv() {
  for (const k of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) {
    delete process.env[k];
  }
}
clearKeyEnv();

const PKG_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ====================================================== 1. index.mjs ======

section('index.mjs: the public surface, and the stubs that must not vanish');
const lib = await import('../../src/index.mjs');

for (const name of ['search', 'searchParallel', 'discoverKeys', 'buildInMemoryState',
                    'setSilent', 'gateStatus', 'assertProviderReady']) {
  eq(`${name} is exported as a function`, typeof lib[name], 'function');
}
eq('GateError is a class', typeof lib.GateError, 'function');
eq('EXIT_CONFIG is sysexits EX_CONFIG', lib.EXIT_CONFIG, 78);

for (const name of ['extract', 'crawl', 'map', 'research', 'researchStart', 'researchPoll']) {
  const r = await rejects(() => lib[name]('anything', { deep: true }));
  ok(`${name}() rejects with RemovedInV8`, r.threw && r.code === 'RemovedInV8', `got ${r.code}`);
  ok(`${name}() points the caller at search()`, r.threw && /Use search\(\)/.test(r.message || ''));
  // A stub that threw synchronously would break `await x().catch(...)`.
  let sync = false;
  try { const p = lib[name]('x'); ok(`${name}() returns a promise, never a sync throw`, p && typeof p.then === 'function'); await p.catch(() => {}); }
  catch { sync = true; ok(`${name}() returns a promise, never a sync throw`, false, 'threw synchronously'); }
  void sync;
}

// A missing submodule in the exports map is invisible until someone imports it.
for (const sub of ['./ai', './preflight', './plan', './validators']) {
  const target = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).exports[sub];
  ok(`exports "${sub}" resolves to a file that exists`, existsSync(path.join(ROOT, target)), target);
  const r = await rejects(() => import(path.join(ROOT, target)));
  ok(`exports "${sub}" imports without side effects`, !r.threw, r.message);
}

{
  const post = readFileSync(path.join(ROOT, 'src', 'install', 'postinstall.mjs'), 'utf8');
  const banner = /surf-agent-skill (\d+\.\d+\.\d+) installed globally/.exec(post);
  bug('V1', 'postinstall announces a hardcoded version that has drifted from package.json',
    !!banner && banner[1] !== PKG_VERSION,
    `postinstall.mjs says ${banner && banner[1]}, package.json says ${PKG_VERSION}`);
  const disp = readFileSync(path.join(ROOT, 'src', 'lib', 'dispatch.mjs'), 'utf8');
  const dv = /const VERSION = '(\d+\.\d+\.\d+)'/.exec(disp);
  bug('V2', 'dispatch sends a hardcoded version in X-Client-Name that has drifted',
    !!dv && dv[1] !== PKG_VERSION,
    `dispatch.mjs sends ${dv && dv[1]}, package.json says ${PKG_VERSION}`);
}

// ================================================= 2. api/search.mjs ======

section('search(): argument validation');
const BAD_QUERIES = [
  ['an empty array', []],
  ['an array of one empty string', ['']],
  ['an array with a blank item', ['ok', '   ']],
  ['a blank string', '   '],
  ['a number', 123],
  ['null', null],
  ['undefined', undefined],
  ['an array of objects', [{ q: 'x' }]],
];
for (const [label, q] of BAD_QUERIES) {
  const r = await rejects(() => lib.search(q, { skipConfigFile: true, skipDotenv: true }));
  ok(`search(${label}) rejects`, r.threw && /non-empty string/.test(r.message || ''), r.message);
}
eq('no bad query reached the wire', fetchCalls.length, 0);

section('search(): the gate contract promised in src/index.mjs:10-13');
{
  // index.mjs promises: "if no valid Brave key can be identified, the promise
  // rejects with a GateError whose `code` is one of BraveKeyMissing /
  // BraveKeyBurned / BraveKeyCooling / BraveKeyInvalid".
  fetchCalls = [];
  const r = await rejects(() => lib.search('q', { braveKeys: [], skipConfigFile: true, skipDotenv: true }));
  ok('an empty braveKeys array does reject', r.threw);
  bug('G1', 'search() with no key rejects with DispatchError/NoProviderAvailable, not GateError/BraveKeyMissing',
    r.threw && !(r.error instanceof lib.GateError),
    `got ${r.name}/${r.code}, exitCode=${r.error && r.error.exitCode} — dispatch.mjs:160 runs buildChain() before assertSearchReady() at :164`);
  bug('G2', 'the rejection carries no exitCode, so a wrapper cannot honour the exit-78 contract',
    r.threw && r.error && r.error.exitCode === undefined,
    'preflight.mjs sets exitCode=78 on GateError; DispatchError has none');
  eq('a keyless search costs no request', fetchCalls.length, 0);
}
{
  // Same for a burned key: BraveKeyBurned is likewise unreachable.
  const home2 = box('burned-home');
  mkdirSync(path.join(home2, '.config', 'surf'), { recursive: true });
  const { saveStateAtomic, loadState } = await import('../../src/lib/state.mjs');
  const st = await loadState();
  st.brave.keys = ['BSA-burned-key-0001'];
  st.brave.burned = [{ index: 0, at: new Date().toISOString(), reason: '401' }];
  await saveStateAtomic(st);
  fetchCalls = [];
  const r = await rejects(() => lib.search('q', { skipDotenv: true }));
  bug('G3', 'a fully burned key ring also rejects with NoProviderAvailable instead of BraveKeyBurned',
    r.threw && r.code === 'NoProviderAvailable',
    `got ${r.name}/${r.code}`);
  st.brave.keys = []; st.brave.burned = [];
  await saveStateAtomic(st);
}
{
  // searchParallel swallows the very failure the project exists to make loud.
  fetchCalls = [];
  // settle(), not a bare await: the FIX for G4 is to make this reject on the
  // gate, and an unguarded await would then be an unhandled rejection that
  // takes this whole suite down instead of flipping G4 to FIXED. The two
  // readings must coexist — today it resolves, after the fix it rejects.
  const g4 = await settle(() => lib.searchParallel(['a', 'b'], { braveKeys: [], skipConfigFile: true, skipDotenv: true }));
  const out = g4.value;
  bug('G4', 'searchParallel() RESOLVES with every batch failed when there is no key — never rejects',
    g4.resolved && out && out.summary && out.summary.succeeded === 0 && out.summary.failed === 2,
    'preflight.mjs:3 — "no 0 sources but exit 0" — holds for the CLI but not for the library fan-out');
  // The invariant that must hold BOTH before and after the fix: a keyless
  // fan-out is never silent. Either it rejects on the gate carrying the exit-78
  // contract (GateError: code BraveKeyMissing, exitCode EXIT_CONFIG=78, pinned
  // at :153), or — as today — it resolves reporting both batches as failed.
  ok('a keyless fan-out is never silent: it rejects with the exit-78 gate contract, or it reports the failures honestly',
    g4.resolved
      ? (!!out && !!out.summary && out.summary.failed === 2)
      : (!!g4.error && g4.error.code === 'BraveKeyMissing' && g4.error.exitCode === 78),
    g4.resolved
      ? `resolved, failed=${out && out.summary && out.summary.failed}`
      : `rejected ${g4.error && g4.error.name}/${g4.error && g4.error.code}, exitCode=${g4.error && g4.error.exitCode}`);
  eq('...costing no request', fetchCalls.length, 0);
}

section('search(): enum validation is not applied uniformly');
{
  const r1 = await rejects(() => lib.search('q', { mode: 'turbo', skipConfigFile: true, skipDotenv: true }));
  ok('a bad --mode on ONE query is a hard usage error', r1.threw && r1.code === 'FLAG_USAGE', r1.code);
  // settle(), same trap as G4: the fix for E1/E2 is to raise FLAG_USAGE the way
  // the single-query form at :283 already does, and a bare await would then be
  // an unhandled rejection that kills the suite instead of flipping the bug.
  const e1 = await settle(() => lib.search(['a', 'b'], { mode: 'turbo', skipConfigFile: true, skipDotenv: true }));
  const r2 = e1.value;
  bug('E1', 'the same bad enum on a BATCH resolves with per-item failures instead of throwing',
    e1.resolved && !!r2 && r2.operation === 'search-batch' && r2.summary.failed === 2,
    'buildArgs() is called inside the per-item try in search.mjs:48');
  const e2 = await settle(() => lib.searchParallel(['a', 'b'], { mode: 'turbo', skipConfigFile: true, skipDotenv: true }));
  const r3 = e2.value;
  bug('E2', 'searchParallel() also downgrades a usage error to a per-item failure',
    e2.resolved && !!r3 && r3.summary.failed === 2,
    'buildArgs() runs inside the mapPool worker in search.mjs:100');
  for (const [name, opts] of [['depth', { depth: 'deep' }], ['topic', { topic: 'sports' }],
                              ['time', { time: 'decade' }], ['safesearch', { safesearch: 'maybe' }]]) {
    const r = await rejects(() => lib.search('q', { ...opts, skipConfigFile: true, skipDotenv: true }));
    ok(`a bad ${name} is rejected`, r.threw && r.code === 'FLAG_USAGE', r.code);
  }
  for (const [name, opts] of [['country', { country: 'ZZZZ' }], ['offset', { offset: 999 }],
                              ['freshness', { freshness: 'yesterday' }], ['max', { max: -5 }]]) {
    const r = await rejects(() => lib.search('q', { ...opts, braveKeys: ['BSA-k'], skipConfigFile: true, skipDotenv: true }));
    ok(`an unvalidated ${name} is passed through to the adapter, not rejected here`, !r.threw || r.code !== 'FLAG_USAGE');
  }
}

section('search(): shapes and discovery');
{
  fetchCalls = [];
  const one = await lib.search(['solo query'], { braveKeys: ['BSA-shape'], skipConfigFile: true, skipDotenv: true, noCache: true });
  bug('S1', 'search(["x"]) returns a bare envelope while search(["x","y"]) returns a batch — the shape depends on length',
    !!one && one.operation !== 'search-batch',
    `one-element array gave operation=${one && one.operation}`);
}
{
  clearKeyEnv();
  process.env.BRAVE_API_KEY = 'BSA-from-environment';
  fetchCalls = [];
  await lib.search('env discovery', { skipConfigFile: true, skipDotenv: true, noCache: true });
  const tokens = fetchCalls.map(c => c.headers['X-Subscription-Token']);
  ok('an undiscovered braveKeys falls back to $BRAVE_API_KEY', tokens.includes('BSA-from-environment'), JSON.stringify(tokens));
  clearKeyEnv();
}

section('searchParallel(): the fan-out width');
{
  // settle() under this loop, and why: every call below is KEYLESS
  // (braveKeys: []), and the G4 fix makes a keyless fan-out REJECT on the
  // gate instead of resolving. A bare await would then be an unhandled
  // rejection that kills this whole suite — probe A of the audit died exactly
  // here. Both readings are legitimate and must coexist (the same two-reading
  // settle() the G4 block above uses): when the call still resolves, the
  // concurrency pin holds; when it rejects, the rejection must carry the
  // exit-78 gate contract.
  const widths = [
    ['a negative width becomes the default', { subAgents: -5 }, 10],
    ['a non-numeric width becomes the default', { subAgents: 'many' }, 10],
    ['NaN becomes the default', { subAgents: NaN }, 10],
    ['a sane width is honoured', { subAgents: 3 }, 3],
    ['a fractional width floors', { subAgents: 3.9 }, 3],
    ['an absurd width clamps to 20', { subAgents: 1e9 }, 20],
    ['Infinity is not finite, so it falls back to the default', { subAgents: Infinity }, 10],
    ['the legacy concurrency alias still works', { concurrency: 4 }, 4],
    ['subAgents wins over concurrency', { subAgents: 2, concurrency: 9 }, 2],
  ];
  for (const [label, opts, expected] of widths) {
    const w = await settle(() => lib.searchParallel(['a'], { ...opts, braveKeys: [], skipConfigFile: true, skipDotenv: true }));
    if (w.resolved) eq(label, w.value.summary.concurrency, expected);
    else ok(label, w.error && w.error.code === 'BraveKeyMissing' && w.error.exitCode === 78,
      `rejected ${w.error && w.error.name}/${w.error && w.error.code}, exitCode=${w.error && w.error.exitCode}`);
  }
  // NOT a contract. This used to be the eq() table row "0 silently becomes
  // the default 10" — an eq() that pinned the DEFECT (subAgents:0 read as
  // "unset", so it became 10) as correct behaviour. The C1 fix makes the code
  // return 1, so that eq() read "got 1" and failed the run instead of flipping
  // the bug — probe B of the audit. The condition below is that row's own
  // condition (concurrency === 10), unchanged; only the channel changed, so a
  // fix reads FIXED instead of failing the run. It is settle()'d for the same
  // reason as the loop: keyless, it rejects once G4 lands.
  const c1 = await settle(() => lib.searchParallel(['a'], { subAgents: 0, braveKeys: [], skipConfigFile: true }));
  bug('C1', 'subAgents:0 means "no fan-out" to a caller but is read as "unset" and becomes 10',
    c1.resolved && c1.value.summary.concurrency === 10,
    'search.mjs — Number(0) is finite but not > 0, so it fell through to the default');
}
{
  for (const [label, q] of [['null', null], ['a number', 42], ['an empty array', []],
                            ['[{}]', [{}]], ['["", "  "]', ['', '  ']], ['[{q:""}]', [{ q: '' }]]]) {
    const r = await rejects(() => lib.searchParallel(q, { braveKeys: [], skipConfigFile: true, skipDotenv: true }));
    ok(`searchParallel(${label}) rejects`, r.threw && /at least one non-empty query/.test(r.message || ''), r.message);
  }
  // settle(), same keyless trap as the widths loop: the G4 fix turns these
  // resolutions into gate rejections. The shape pins hold in the resolving
  // regime; a rejection must carry the exit-78 gate contract instead.
  const single = await settle(() => lib.searchParallel('a bare string', { braveKeys: [], skipConfigFile: true }));
  if (single.resolved) eq('a bare string is wrapped into one item', single.value.summary.total, 1);
  else ok('a bare string is wrapped into one item', single.error && single.error.code === 'BraveKeyMissing' && single.error.exitCode === 78,
    `rejected ${single.error && single.error.name}/${single.error && single.error.code}, exitCode=${single.error && single.error.exitCode}`);
  const obj = await settle(() => lib.searchParallel({ q: 'object form' }, { braveKeys: [], skipConfigFile: true }));
  if (obj.resolved) eq('a bare object is wrapped into one item', obj.value.summary.total, 1);
  else ok('a bare object is wrapped into one item', obj.error && obj.error.code === 'BraveKeyMissing' && obj.error.exitCode === 78,
    `rejected ${obj.error && obj.error.name}/${obj.error && obj.error.code}, exitCode=${obj.error && obj.error.exitCode}`);
  const mixed = await settle(() => lib.searchParallel(['keep', { q: '' }, { query: 'also keep' }, 'keep too'],
    { braveKeys: [], skipConfigFile: true }));
  if (mixed.resolved) eq('empty items are dropped, the rest survive', mixed.value.summary.total, 3);
  else ok('empty items are dropped, the rest survive', mixed.error && mixed.error.code === 'BraveKeyMissing' && mixed.error.exitCode === 78,
    `rejected ${mixed.error && mixed.error.name}/${mixed.error && mixed.error.code}, exitCode=${mixed.error && mixed.error.exitCode}`);
  const huge = await settle(() => lib.searchParallel(Array.from({ length: 200 }, (_, i) => `q${i}`),
    { braveKeys: [], skipConfigFile: true }));
  if (huge.resolved) eq('a 200-query fan-out does not blow up', huge.value.summary.total, 200);
  else ok('a 200-query fan-out does not blow up', huge.error && huge.error.code === 'BraveKeyMissing' && huge.error.exitCode === 78,
    `rejected ${huge.error && huge.error.name}/${huge.error && huge.error.code}, exitCode=${huge.error && huge.error.exitCode}`);
}
{
  // settle(), same keyless trap as the widths loop: once G4 lands, this call
  // rejects on the gate, so the collision shape is only observable while it
  // still resolves. The bug() reads FIXED in the rejecting regime without
  // changing what it measures — the rejection's own gate contract is what the
  // G4 block asserts.
  const dupIds = await settle(() => lib.searchParallel([{ id: 'same', q: 'a' }, { id: 'same', q: 'b' }],
    { braveKeys: [], skipConfigFile: true }));
  bug('C2', 'caller-supplied ids are not checked for collisions — two batches come back with the same id',
    dupIds.resolved && dupIds.value.data.batches[0].id === dupIds.value.data.batches[1].id,
    'a caller keying results by id silently loses one');
}
{
  fetchCalls = [];
  await lib.searchParallel(['identical', 'identical', 'identical'],
    { braveKeys: ['BSA-dup'], skipConfigFile: true, skipDotenv: true, noCache: true });
  const q = wireQueries().filter(x => x === 'identical');
  bug('C3', 'duplicate queries in one fan-out are not deduped — each one spends a Brave credit',
    q.length > 1, `"identical" hit the wire ${q.length}x`);
}

section('search(): the harness budget escape hatch is missing from search()');
{
  process.env.SURF_AGENT_BUDGET_MS = '1100';
  fetchCalls = [];
  const par = await lib.searchParallel(['budget'], { braveKeys: ['BSA-budget'], skipConfigFile: true, skipDotenv: true, noCache: true });
  ok('searchParallel defaults to no-budget and completes', par.summary.succeeded === 1, JSON.stringify(par.summary));
  const r = await rejects(() => lib.search('budget', { braveKeys: ['BSA-budget'], noBudget: true, skipConfigFile: true, skipDotenv: true, noCache: true }));
  bug('B1', 'search() ignores opts.noBudget — buildFlags() never forwards it, so a library call still aborts on the harness budget',
    r.threw && r.code === 'LikelyAgentTimeout',
    `search.mjs:156-163 builds flags without no-budget; got ${r.code}`);
  delete process.env.SURF_AGENT_BUDGET_MS;
}
{
  // buildFlags() hardcodes confirm-expensive:true. Pinned rather than flagged:
  // with Brave as the only backend the estimate for a search is 1 credit and
  // guardExpensive() only fires above 10, so the bypass is currently inert.
  const { estimateCreditsForChain } = await import('../../src/lib/cost.mjs');
  eq('one search is one credit, so the confirm-expensive bypass is inert today',
    estimateCreditsForChain('search', {}, ['brave']), 1);
}

// ====================================================== 3. env.mjs ========

section('env.mjs: discovery precedence');
const { discoverKeys, buildInMemoryState } = lib;
{
  const d = box('discovery');
  writeFileSync(path.join(d, '.env'), 'BRAVE_API_KEY=from-dotenv\n');
  clearKeyEnv();
  process.env.BRAVE_API_KEY = 'from-env';
  const home3 = path.join(HOME, '.config', 'surf');
  mkdirSync(home3, { recursive: true });
  writeFileSync(path.join(home3, 'keys.json'), JSON.stringify({
    schema_version: 1, last_ok_provider: null,
    brave: { keys: ['from-keysjson'], current: 0, burned: [], cooldowns: [], validated: [] },
    openrouter: { keys: ['orr-from-keysjson'], current: 0, burned: [], cooldowns: [], validated: [] },
  }, null, 2));

  const got = await discoverKeys({ braveKeys: ['from-opts'], cwd: d });
  eq('opts, then env, then .env — in that order', got.brave.join(','), 'from-opts,from-env,from-dotenv');
  ok('keys.json is NOT merged once an earlier level answered', !got.brave.includes('from-keysjson'));
  eq('...but a provider with no earlier answer still falls back to keys.json',
    got.openrouter.join(','), 'orr-from-keysjson');
  bug('D1', 'the header comment in env.mjs:2 promises "each level can contribute; results merged + deduped", which is false for level 4',
    !got.brave.includes('from-keysjson'),
    'env.mjs:95-105 consults keys.json only when levels 1-3 produced nothing for that provider');

  const deduped = await discoverKeys({ braveKeys: ['from-env', 'from-env', 'x'], cwd: d });
  eq('duplicates across and within sources collapse', deduped.brave.join(','), 'from-env,x,from-dotenv');

  eq('skipDotenv drops level 3',
    (await discoverKeys({ braveKeys: ['a'], cwd: d, skipDotenv: true })).brave.join(','), 'a,from-env');
  eq('skipConfigFile drops level 4',
    (await discoverKeys({ cwd: d, skipConfigFile: true, skipDotenv: true })).openrouter.length, 0);
  clearKeyEnv();
}

section('env.mjs: the .env parser');
{
  const cases = [
    ['BRAVE_API_KEY=plain', ['plain'], true, 'a plain assignment'],
    ['BRAVE_API_KEY="double"', ['double'], true, 'double quotes are stripped'],
    ['BRAVE_API_KEYS=a, b ,c', ['a', 'b', 'c'], true, 'the KEYS form splits on commas and trims'],
    ['# BRAVE_API_KEY=commented', [], true, 'a commented line is ignored'],
    ['BRAVE_API_KEY=ok\n\x00\x01\x02garbage\nnot a line at all\n', ['ok'], true, 'binary garbage does not derail the parse'],
  ];
  for (const [body, expected, mustHold, label] of cases) {
    const d = box('dotenv');
    writeFileSync(path.join(d, '.env'), body + '\n');
    const got = await discoverKeys({ cwd: d, skipConfigFile: true });
    if (mustHold) eq(label, got.brave.join(','), expected.join(','));
  }
  const bad = [
    ['P1', "export BRAVE_API_KEY=exported", 'the `export FOO=bar` form every shell-sourced .env uses is silently ignored', []],
    ['P2', "BRAVE_API_KEY='single'", 'single quotes are NOT stripped — the quotes become part of the key', ["'single'"]],
    ['P3', 'BRAVE_API_KEY=abc#def', 'a `#` inside the value truncates the key instead of being taken literally', ['abc']],
    ['P4', 'BRAVE_API_KEY=has"quote', 'a `"` anywhere in the value drops the whole line', []],
    ['P5', 'brave_api_key=lowercase', 'a lowercase variable name is ignored', []],
  ];
  for (const [id, body, why, expected] of bad) {
    const d = box('dotenv-bad');
    writeFileSync(path.join(d, '.env'), body + '\n');
    const got = await discoverKeys({ cwd: d, skipConfigFile: true });
    bug(id, why, got.brave.join(',') === expected.join(','), `parsed ${JSON.stringify(got.brave)} from ${JSON.stringify(body)}`);
  }
  // A .env that cannot be read must not take the process down.
  const d1 = box('dotenv-dir');
  mkdirSync(path.join(d1, '.env'));
  const r1 = await rejects(() => discoverKeys({ cwd: d1, skipConfigFile: true }));
  ok('a directory named .env does not crash discovery', !r1.threw, r1.message);
  const d2 = box('dotenv-none');
  const r2 = await rejects(() => discoverKeys({ cwd: d2, skipConfigFile: true }));
  ok('an absent .env does not crash discovery', !r2.threw, r2.message);
  const d3 = box('dotenv-noperm');
  writeFileSync(path.join(d3, '.env'), 'BRAVE_API_KEY=secret\n');
  chmodSync(path.join(d3, '.env'), 0o000);
  const r3 = await rejects(() => discoverKeys({ cwd: d3, skipConfigFile: true }));
  ok('an unreadable .env does not crash discovery', !r3.threw, r3.message);
  chmodSync(path.join(d3, '.env'), 0o600);
}
{
  const d = box('dotenv-cache');
  writeFileSync(path.join(d, '.env'), 'BRAVE_API_KEY=first\n');
  const a = await discoverKeys({ cwd: d, skipConfigFile: true });
  writeFileSync(path.join(d, '.env'), 'BRAVE_API_KEY=second\n');
  const b = await discoverKeys({ cwd: d, skipConfigFile: true });
  bug('D2', 'ENV_FILE_CACHE never expires — a rewritten .env is invisible for the life of the process',
    a.brave.join(',') === 'first' && b.brave.join(',') === 'first',
    `second read still returned ${JSON.stringify(b.brave)}`);
}

section('env.mjs: opts are not normalised the way env vars are');
{
  const csv = await discoverKeys({ braveKeys: 'k1,k2', skipConfigFile: true, skipDotenv: true });
  bug('D3', 'opts.braveKeys as a CSV string is taken as ONE key — only the env vars split on commas',
    csv.brave.length === 1 && csv.brave[0] === 'k1,k2',
    `got ${JSON.stringify(csv.brave)}; BRAVE_API_KEYS="k1,k2" would have given two`);
  const junk = await discoverKeys({ braveKeys: [123, null, '', false, 'good'], skipConfigFile: true, skipDotenv: true });
  bug('D4', 'non-string entries in opts.braveKeys survive discovery and reach the auth header',
    junk.brave.some(k => typeof k !== 'string'),
    `got ${JSON.stringify(junk.brave)}`);
  const both = await discoverKeys({ braveKey: 'singular', braveKeys: ['plural'], skipConfigFile: true, skipDotenv: true });
  eq('braveKey and braveKeys merge, singular first', both.brave.join(','), 'singular,plural');
}

section('env.mjs: buildInMemoryState carries history by key VALUE');
{
  const cfg = path.join(HOME, '.config', 'surf');
  mkdirSync(cfg, { recursive: true });
  const iso = new Date().toISOString();
  const soon = new Date(Date.now() + 60_000).toISOString();
  const write = (brave) => writeFileSync(path.join(cfg, 'keys.json'), JSON.stringify({
    schema_version: 1, last_ok_provider: 'brave',
    brave, openrouter: { keys: [], current: 0, burned: [], cooldowns: [], validated: [] },
  }, null, 2));

  // A / B / C on disk; B burned, C cooling, A validated. The caller passes a
  // DIFFERENT order and drops B, so every index must be recomputed.
  write({
    keys: ['KEY-A', 'KEY-B', 'KEY-C'], current: 2,
    burned: [{ index: 1, at: iso, reason: '401' }],
    cooldowns: [{ index: 2, until: soon }],
    validated: [{ index: 0, at: iso, ok: true, status: 200, reason: null }],
  });
  const st = await buildInMemoryState({ braveKeys: ['KEY-C', 'KEY-A'], skipDotenv: true });
  eq('the merged key order is the caller order', st.brave.keys.join(','), 'KEY-C,KEY-A');
  eq('the cooldown followed KEY-C to its new index', (st.brave.cooldowns[0] || {}).index, 0);
  eq('the validation followed KEY-A to its new index', (st.brave.validated[0] || {}).index, 1);
  eq('the burn on the dropped KEY-B did not land on anyone', st.brave.burned.length, 0);
  ok('history is matched by value, never by position',
    st.brave.cooldowns.length === 1 && st.brave.validated.length === 1);
  eq('the state is flagged in-memory so dispatch never persists it', st.brave && st._inMemory, true);

  // The docstring (env.mjs:125-126) claims opts/env keys "have no history and
  // start clean". They do not.
  write({ keys: ['KEY-OPTS'], current: 0, burned: [{ index: 0, at: iso, reason: '401' }], cooldowns: [], validated: [] });
  const st2 = await buildInMemoryState({ braveKeys: ['KEY-OPTS'], skipDotenv: true });
  bug('M1', 'a key passed explicitly in opts inherits keys.json burn history, contradicting the docstring at env.mjs:125-126',
    st2.brave.burned.length === 1,
    'discoverKeys never even reads keys.json for that provider, yet buildInMemoryState does; only skipConfigFile opts out');
  const st3 = await buildInMemoryState({ braveKeys: ['KEY-OPTS'], skipConfigFile: true, skipDotenv: true });
  eq('skipConfigFile is the only escape, and it works', st3.brave.burned.length, 0);

  // A hand-edited keys.json can hold the same key twice; the value->index Map
  // keeps only the LAST occurrence.
  write({
    keys: ['KEY-DUP', 'KEY-DUP'], current: 0,
    burned: [{ index: 0, at: iso, reason: '401' }], cooldowns: [], validated: [],
  });
  const st4 = await buildInMemoryState({ skipDotenv: true });
  bug('M2', 'a duplicated key in keys.json loses its burn — the value→index Map keeps only the last occurrence',
    st4.brave.keys.length === 1 && st4.brave.burned.length === 0,
    'env.mjs:145 — new Map(src.keys.map((k,i)=>[k,i])); a key the CLI proved dead comes back clean');

  // A stale burn index (hand-edited keys.json) points past the end of the ring.
  write({ keys: ['KEY-ONLY'], current: 0, burned: [{ index: 7, at: iso, reason: '401' }], cooldowns: [], validated: [] });
  const st5 = await buildInMemoryState({ skipDotenv: true });
  eq('a burn index with no matching key is dropped, not applied to key 0', st5.brave.burned.length, 0);

  write({ keys: [], current: 0, burned: [], cooldowns: [], validated: [] });
}

// ============================================== 4. harness-install.mjs ====

section('harness-install: HARNESS_DIRS must be inside the throwaway home');
const hi = await import('../../src/lib/harness-install.mjs');
for (const d of hi.HARNESS_DIRS) {
  ok(`${d.replace(HOME, '$HOME')} is under the sandbox home`, d.startsWith(HOME));
}
eq('four harness dirs are targeted', hi.HARNESS_DIRS.length, 4);

section('harness-install: symlinkOrCopy against every kind of squatter');
{
  const d = box('symlink');
  const pkg = fakePkg(d);
  const dir = path.join(d, 'skills');
  mkdirSync(dir);

  const l1 = path.join(dir, 'fresh');
  eq('a free path is symlinked', (await hi.symlinkOrCopy(pkg, l1)).action, 'symlinked');
  eq('the symlink points at the package', readlinkSync(l1), pkg);
  eq('re-running is a no-op', (await hi.symlinkOrCopy(pkg, l1)).action, 'kept-symlink');

  const l2 = path.join(dir, 'user-file');
  writeFileSync(l2, 'MY NOTES');
  eq('a regular file is preserved', (await hi.symlinkOrCopy(pkg, l2)).action, 'preserved-existing');
  eq('...and its content is untouched', readFileSync(l2, 'utf8'), 'MY NOTES');

  const l3 = path.join(dir, 'user-dir');
  mkdirSync(l3); writeFileSync(path.join(l3, 'MINE.md'), 'MY SKILL');
  eq('a real directory is preserved', (await hi.symlinkOrCopy(pkg, l3)).action, 'preserved-existing');
  eq('...and its content is untouched', readFileSync(path.join(l3, 'MINE.md'), 'utf8'), 'MY SKILL');

  const other = path.join(d, 'their-skill');
  mkdirSync(other); writeFileSync(path.join(other, 'THEIRS.md'), 'x');
  const l4 = path.join(dir, 'user-symlink');
  symlinkSync(other, l4);
  const r4 = await hi.symlinkOrCopy(pkg, l4);
  eq('a symlink pointing elsewhere is replaced (documented as "stale")', r4.action, 'symlinked');
  ok('the user target itself is not deleted, only the link', existsSync(path.join(other, 'THEIRS.md')));

  // The module header claims: "Idempotent: re-running fixes stale symlinks".
  const l5 = path.join(dir, 'broken');
  symlinkSync(path.join(d, 'moved-away'), l5);
  const r5 = await rejects(() => hi.symlinkOrCopy(pkg, l5));
  bug('H1', 'a BROKEN symlink is never repaired — existsSync() follows the link, so the repair branch is skipped and fs.cp throws',
    r5.threw,
    `${r5.code} — harness-install.mjs:48 uses existsSync (follows) instead of lstat; this is exactly the state a moved/renamed install leaves behind`);
  ok('the broken link is still there afterwards', lstatSync(l5).isSymbolicLink());
}
{
  // The throw above does not stay local: it costs the whole harness dir.
  const d = box('install-abort');
  const pkg = fakePkg(d);
  const dir = hi.HARNESS_DIRS[0];
  mkdirSync(dir, { recursive: true });
  symlinkSync(path.join(d, 'nowhere'), path.join(dir, 'surf-research-agent-skill'));
  const res = await hi.installSkill(pkg);
  const first = res.filter(r => String(r.dir).startsWith(dir));
  bug('H2', 'one broken symlink aborts the SKILLS loop for that harness dir — the second skill is never installed there',
    first.length === 1 && first[0].action === 'error',
    `harness-install.mjs:117-127 wraps both skills in one try; got ${JSON.stringify(first)}`);
  ok('the other harness dirs still got both skills', res.filter(r => r.action === 'symlinked').length >= 6);
  for (const dd of hi.HARNESS_DIRS) rmSync(dd, { recursive: true, force: true });
}

section('harness-install: install / uninstall round trip');
{
  const d = box('roundtrip');
  const pkg = fakePkg(d);
  const res = await hi.installSkill(pkg);
  eq('three skills into four harness dirs', res.filter(r => r.action === 'symlinked').length, 12);
  for (const dir of hi.HARNESS_DIRS) {
    ok(`${path.basename(path.dirname(dir))}: root skill linked`,
      readlinkSync(path.join(dir, 'surf-research-agent-skill')) === pkg);
    ok(`${path.basename(path.dirname(dir))}: plan skill linked`,
      readlinkSync(path.join(dir, 'surf-plan-agent-skill')) === path.join(pkg, 'skills', 'surf-plan-agent-skill'));
  }
  // A user file wearing our name must survive an uninstall.
  const squat = path.join(hi.HARNESS_DIRS[1], 'surf-research-agent-skill');
  rmSync(squat); writeFileSync(squat, 'USER COPY');
  const un = await hi.uninstallSkill(pkg);
  eq('seven of our eight links are removed', un.filter(r => r.removed).length, 7);
  eq('the user copy is left alone', readFileSync(squat, 'utf8'), 'USER COPY');
  rmSync(squat);
  for (const dir of hi.HARNESS_DIRS) rmSync(dir, { recursive: true, force: true });
}
{
  const d = box('dangling-uninstall');
  const pkg = fakePkg(d);
  const dir = hi.HARNESS_DIRS[0];
  mkdirSync(dir, { recursive: true });
  const link = path.join(dir, 'surf-research-agent-skill');
  symlinkSync(pkg, link);
  rmSync(pkg, { recursive: true, force: true }); // package moved/removed first
  const removed = await hi.unlinkIfOurs(link, pkg);
  bug('H3', 'unlinkIfOurs() refuses to remove OUR OWN symlink once it dangles — existsSync() returns false for a broken link',
    removed === false && lstatSync(link).isSymbolicLink(),
    'harness-install.mjs:81 — uninstalling after the package dir is gone leaves the dead link forever');
  // force: the fix for H3 makes unlinkIfOurs() delete this link itself, and an
  // unguarded rmSync would then throw ENOENT and fail the suite for being fixed.
  rmSync(link, { force: true });
}

{
  // Permission denied on the link's directory: EACCES is NOT in the tolerated
  // set (EPERM/ENOSYS/EEXIST), so it propagates — correctly, but check that it
  // stays contained to the one dir.
  if (process.getuid && process.getuid() === 0) {
    process.stdout.write('  · skipped read-only harness dir (running as root)\n');
  } else {
    const d = box('noperm');
    const pkg = fakePkg(d);
    const dir = hi.HARNESS_DIRS[3];
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    const r = await rejects(() => hi.symlinkOrCopy(pkg, path.join(dir, 'surf-research-agent-skill')));
    ok('symlinkOrCopy surfaces EACCES rather than silently copying', r.threw && r.code === 'EACCES', r.code);
    const res = await hi.installSkill(pkg);
    const bad = res.filter(x => x.action === 'error');
    eq('an unwritable harness dir is reported as one error', bad.length, 1);
    ok('...and the other three dirs still receive all three skills',
      res.filter(x => x.action === 'symlinked').length === 9);
    chmodSync(dir, 0o755);
    for (const dd of hi.HARNESS_DIRS) rmSync(dd, { recursive: true, force: true });
  }
}
{
  // uninstallSkill only knows SKILLS, never LEGACY_NAMES.
  const dir = hi.HARNESS_DIRS[0];
  mkdirSync(dir, { recursive: true });
  const d = box('uninstall-legacy');
  const pkg = fakePkg(d);
  await hi.installSkill(pkg);
  symlinkSync(pkg, path.join(dir, 'surf-free-agent-skill'));
  await hi.uninstallSkill(pkg);
  // Same predicate as before — "the legacy link is still there, live or dangling"
  // — but the lstat is ENOENT-safe: today existsSync() short-circuits it, and
  // the day uninstallSkill() does remove the link, the raw lstat would throw
  // before bug() was ever reached and kill the suite instead of flipping H12.
  const legacyLink = path.join(dir, 'surf-free-agent-skill');
  bug('H12', 'uninstallSkill() never touches LEGACY_NAMES — the v7 surf-free-agent-skill link survives a full uninstall',
    existsSync(legacyLink) || (lstatOrNull(legacyLink) || { isSymbolicLink: () => false }).isSymbolicLink(),
    'only postinstall calls cleanupLegacy(); `npm rm -g` leaves the keyless-search skill advertised');
  for (const dd of hi.HARNESS_DIRS) rmSync(dd, { recursive: true, force: true });
}

section('harness-install: relative symlinks are resolved against the WRONG base');
{
  const d = box('relative');
  const pkg = fakePkg(d, 'surf-agent-skill');
  const dir = path.join(d, 'skills');
  mkdirSync(dir);
  const link = path.join(dir, 'surf-research-agent-skill');
  symlinkSync(path.relative(dir, pkg), link);
  ok('the relative link really does point at the package', path.resolve(dir, readlinkSync(link)) === pkg);
  const cwd0 = process.cwd();
  process.chdir(d);
  const removed = await hi.unlinkIfOurs(link, pkg);
  bug('H4', 'a RELATIVE symlink of ours is not recognised as ours — path.resolve() uses process.cwd(), not dirname(link)',
    removed === false,
    'harness-install.mjs:86 — path.resolve(cur) should be path.resolve(path.dirname(link), cur)');
  process.chdir(cwd0);
  // force: same trap as H3 — once H4 is fixed the link is already gone here.
  rmSync(link, { force: true });
}
{
  // The same flaw in the other direction: it DELETES a link that is not ours.
  const d = box('relative-destructive');
  const victimTarget = path.join(d, 'skills', 'their-notes');
  mkdirSync(victimTarget, { recursive: true });
  writeFileSync(path.join(victimTarget, 'THEIRS.md'), 'user content');
  // Our package happens to sit at <cwd>/their-notes — npm runs lifecycle
  // scripts with cwd set to the package root's parent layout, so the basenames
  // colliding is all it takes.
  const pkg = fakePkg(d, 'their-notes');
  const link = path.join(d, 'skills', 'surf-research-agent-skill');
  symlinkSync('their-notes', link); // relative -> ./skills/their-notes (the USER's dir)
  const cwd0 = process.cwd();
  process.chdir(d);
  const removed = await hi.unlinkIfOurs(link, pkg);
  process.chdir(cwd0);
  bug('H5', 'unlinkIfOurs() DELETES a symlink that points at the user\'s own directory, because cwd made the relative target resolve onto our package path',
    removed === true && !existsSync(link),
    'harness-install.mjs:85-88 — the answer to "can uninstall delete something that is not ours?" is yes, for relative symlinks');
  ok('the user\'s files behind the link survive (only the link was destroyed)',
    existsSync(path.join(victimTarget, 'THEIRS.md')));
}

section('harness-install: legacy cleanup');
{
  const dir = hi.HARNESS_DIRS[1];
  mkdirSync(dir, { recursive: true });
  const d = box('legacy');
  // Links a PRIOR RELEASE OF THIS PACKAGE created: absolute, and pointing into
  // the package root — which is ROOT, exactly what harness-install.mjs derives
  // from its own module URL. The fixture has to be provable, because
  // cleanupLegacy() now deletes only what it can prove is ours (H13); a link
  // into an arbitrary directory is indistinguishable from a user's own.
  // `surf-free-agent-skill` is the real v7→v8 shape: OURS and DANGLING, since
  // v8 deleted the directory it points at.
  symlinkSync(path.join(ROOT, 'skills', 'surf-free-agent-skill'), path.join(dir, 'surf-free-agent-skill'));
  symlinkSync(ROOT, path.join(dir, 'tavily')); // pre-rename link to the root skill
  symlinkSync(path.join(ROOT, 'gone-away'), path.join(dir, 'surf-skill')); // broken legacy link
  // The npm package itself was renamed (surf-skill → surf-agent-skill), so a
  // link from v7-and-earlier points at a SIBLING install, not into this root.
  const oldPkg = path.join(d, 'node_modules', 'surf-skill');
  mkdirSync(oldPkg, { recursive: true });
  symlinkSync(oldPkg, path.join(dir, 'surf-search-skill'));
  const res = await hi.cleanupLegacy();
  ok('the v8-deleted surf-free-agent-skill symlink is really removed',
    !existsSync(path.join(dir, 'surf-free-agent-skill')) &&
    !res.every(r => !String(r.removed).endsWith('surf-free-agent-skill')));
  ok('a legacy tavily symlink is removed', !existsSync(path.join(dir, 'tavily')));
  let brokenGone = true;
  try { lstatSync(path.join(dir, 'surf-skill')); brokenGone = false; } catch {}
  ok('a BROKEN legacy symlink is removed too (lstat, not existsSync)', brokenGone);
  ok('a link into the PRE-RENAME package (node_modules/surf-skill) is ours too, and goes',
    !existsSync(path.join(dir, 'surf-search-skill')) && !lstatOrNull(path.join(dir, 'surf-search-skill')));

  // The Windows fallback in this same module writes a real directory copy.
  // cleanupLegacy only ever removes symlinks, so that copy is immortal.
  const copyDir = path.join(dir, 'surf-free-agent-skill');
  mkdirSync(copyDir); writeFileSync(path.join(copyDir, 'SKILL.md'), 'v7 keyless skill');
  await hi.cleanupLegacy();
  bug('H6', 'a legacy skill installed as a COPY (the Windows fallback of this very module) is never cleaned up',
    existsSync(path.join(copyDir, 'SKILL.md')),
    'harness-install.mjs:158 only unlinks symlinks — the v7 keyless skill keeps advertising a binary that no longer exists');
  rmSync(dir, { recursive: true, force: true });
}
{
  // LEGACY_NAMES contains bare 'surf', and 'tavily' — the competitor's product
  // name, the likeliest collision of all. Any symlink wearing one of them used
  // to die, whoever made it.
  //
  // NOT a contract. This was an ok() that asserted the deletion of a THIRD
  // PARTY'S file as correct behaviour ("documented at harness-install.mjs:30")
  // — the same defect H5 records for unlinkIfOurs(), reached through the second
  // entry point, and since the preuninstall sweep it fires on uninstall too.
  // The condition below is the ok()'s own condition, unchanged; only the
  // channel changed, so a fix reads FIXED instead of failing the run.
  const dir = hi.HARNESS_DIRS[1];
  mkdirSync(dir, { recursive: true });
  const d = box('legacy-collateral');
  const mine = path.join(d, 'my-own-surf-skill');
  mkdirSync(mine); writeFileSync(path.join(mine, 'SKILL.md'), 'MY OWN SKILL');
  symlinkSync(mine, path.join(dir, 'surf'));
  const theirs = path.join(d, 'their-tavily');
  mkdirSync(theirs); writeFileSync(path.join(theirs, 'SKILL.md'), 'THEIR SKILL');
  symlinkSync(theirs, path.join(dir, 'tavily'));
  // A real directory wearing a legacy name — never a candidate at all.
  mkdirSync(path.join(dir, 'surf-plan'));
  writeFileSync(path.join(dir, 'surf-plan', 'SKILL.md'), 'MY PLAN SKILL');
  // The hostile case: a RELATIVE link of the user's whose stored target, joined
  // to a cwd npm happens to have parked us in, lands INSIDE our package root.
  // Resolved the kernel's way (against dirname(link)) it points nowhere near.
  symlinkSync(path.join('skills', 'surf-free-agent-skill'), path.join(dir, 'tvly'));
  const cwd0 = process.cwd();
  process.chdir(ROOT);
  const res = await hi.cleanupLegacy();
  process.chdir(cwd0);
  bug('H13', 'cleanupLegacy() deletes ANY symlink wearing a legacy name, ours or not — a user\'s own skill called "surf" or "tavily" is destroyed by every install, and by every uninstall since the preuninstall sweep',
    !existsSync(path.join(dir, 'surf')),
    'harness-install.mjs:205 unlinked by NAME with no proof of ownership — the defect H5 closed in unlinkIfOurs(), through the second entry point');
  ok('a user symlink named "tavily" survives — the name is a legacy skill of ours AND a real product of someone else\'s',
    existsSync(path.join(dir, 'tavily')));
  ok('a real directory wearing a legacy name is never touched',
    lstatSync(path.join(dir, 'surf-plan')).isDirectory() &&
    readFileSync(path.join(dir, 'surf-plan', 'SKILL.md'), 'utf8') === 'MY PLAN SKILL');
  ok('a BROKEN link of the user\'s survives a hostile cwd — an unprovable link is kept, never guessed at',
    !!lstatOrNull(path.join(dir, 'tvly')));
  ok('the files behind the user\'s links are untouched (we remove link entries, never targets)',
    existsSync(path.join(mine, 'SKILL.md')) && existsSync(path.join(theirs, 'SKILL.md')));
  ok('every link we refused to remove is reported back to the caller',
    Array.isArray(res.kept) &&
    ['surf', 'tavily', 'tvly'].every(n => res.kept.some(k => k.kept === path.join(dir, n))),
    JSON.stringify(res.kept));
  eq('...and nothing else was removed from that dir', res.filter(r => String(r.removed).startsWith(dir)).length, 0);
  rmSync(dir, { recursive: true, force: true });
}
{
  if (process.getuid && process.getuid() === 0) {
    process.stdout.write('  · skipped (running as root: chmod 000 does not deny)\n');
  } else {
    const dir = hi.HARNESS_DIRS[2];
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    const r = await rejects(() => hi.cleanupLegacy());
    chmodSync(dir, 0o755);
    bug('H7', 'cleanupLegacy() rethrows EACCES from ONE unreadable harness dir, aborting the whole postinstall before any skill is installed',
      r.threw,
      `harness-install.mjs:163 — got ${r.code}; postinstall.mjs:45 runs cleanupLegacy() first, so the three healthy dirs get nothing`);
    rmSync(dir, { recursive: true, force: true });
  }
}

section('harness-install: ensureKeysSkeleton');
{
  const cfg = path.join(HOME, '.config', 'surf', 'keys.json');
  rmSync(cfg, { force: true });
  const a = await hi.ensureKeysSkeleton();
  ok('a fresh keys.json is created', !!a.created && existsSync(cfg));
  eq('it is chmod 600', (statSync(cfg).mode & 0o777).toString(8), '600');
  const b = await hi.ensureKeysSkeleton();
  ok('a second call leaves the existing file alone', !!b.existed);
  const skel = JSON.parse(readFileSync(cfg, 'utf8'));
  bug('H8', 'the skeleton is an inline literal missing `validated` — the exact trap keys-cmd.mjs:208 documents as a bug',
    !Array.isArray(skel.brave.validated),
    'harness-install.mjs:178 should call blankProvider() from state.mjs');
  rmSync(cfg, { force: true });
}

// ========================================== 5. postinstall / preuninstall =

section('install scripts: they must never fail an npm install');
function runScript(script, extraEnv = {}, homeDir = null) {
  const h = homeDir || box('script-home');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'install', script)], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test',
      HOME: h, USERPROFILE: h,
      ...extraEnv,
    },
  });
  return { ...r, home: h };
}
{
  const r = runScript('postinstall.mjs');
  eq('a LOCAL install exits 0', r.status, 0);
  ok('...and says so', /installed as a library/.test(r.stdout));
  ok('...and touches nothing in HOME', !existsSync(path.join(r.home, '.claude')) && !existsSync(path.join(r.home, '.config')));
}
{
  const r = runScript('postinstall.mjs', { SURF_DEV: '1' });
  eq('a DEV/global install exits 0', r.status, 0);
  ok('...and links the root skill', existsSync(path.join(r.home, '.claude', 'skills', 'surf-research-agent-skill', 'SKILL.md')));
  ok('...and links the plan skill', existsSync(path.join(r.home, '.agents', 'skills', 'surf-plan-agent-skill', 'SKILL.md')));
  ok('...and creates the keys skeleton', existsSync(path.join(r.home, '.config', 'surf', 'keys.json')));
  const again = runScript('postinstall.mjs', { SURF_DEV: '1' }, r.home);
  eq('re-running is idempotent and still exits 0', again.status, 0);
  ok('...reporting the links as already present', /already linked/.test(again.stdout));

  const un = runScript('preuninstall.mjs', {}, r.home);
  eq('preuninstall exits 0', un.status, 0);
  ok('...and removes our links', !existsSync(path.join(r.home, '.claude', 'skills', 'surf-research-agent-skill')));
  ok('...and preserves keys.json', existsSync(path.join(r.home, '.config', 'surf', 'keys.json')));
  const un2 = runScript('preuninstall.mjs', {}, r.home);
  eq('a second uninstall is still exit 0', un2.status, 0);
}
{
  const r = runScript('postinstall.mjs', { npm_config_global: 'true' });
  eq('npm_config_global=true takes the global branch, exit 0', r.status, 0);
  ok('...and installs', existsSync(path.join(r.home, '.claude', 'skills', 'surf-research-agent-skill')));
}
{
  if (process.getuid && process.getuid() === 0) {
    process.stdout.write('  · skipped read-only HOME (running as root)\n');
  } else {
    const h = box('ro-home');
    chmodSync(h, 0o500);
    const r = runScript('postinstall.mjs', { SURF_DEV: '1' }, h);
    chmodSync(h, 0o755);
    eq('a read-only HOME still exits 0', r.status, 0);
    ok('...and warns instead of crashing', /warning|⚠/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(0, 200));
  }
}
{
  const d = box('file-home');
  const h = path.join(d, 'home-is-a-file');
  writeFileSync(h, 'not a directory');
  const r = runScript('postinstall.mjs', { SURF_DEV: '1' }, h);
  eq('a HOME that is a regular file still exits 0', r.status, 0);
  const u = runScript('preuninstall.mjs', {}, h);
  eq('...and so does preuninstall', u.status, 0);
}
{
  const h = box('broken-link-home');
  const skills = path.join(h, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  symlinkSync(path.join(h, 'gone'), path.join(skills, 'surf-research-agent-skill'));
  const r = runScript('postinstall.mjs', { SURF_DEV: '1' }, h);
  eq('a pre-existing broken link does not fail the install', r.status, 0);
  bug('H9', 'a stale broken link makes postinstall report an error for that harness dir instead of repairing it',
    /⚠ .*skills:/.test(r.stdout),
    r.stdout.split('\n').filter(l => l.includes('⚠')).join(' | ').slice(0, 200));
}
{
  // stdout that cannot be written (ENOSPC on /dev/full, EPIPE from a closed
  // reader). package.json wraps both scripts in `|| true`, so npm survives —
  // but the script itself is the thing under test here.
  if (existsSync('/dev/full')) {
    const h = box('devfull-home');
    const r = spawnSync('/bin/sh', ['-c',
      `exec "$1" "$2" >/dev/full 2>/dev/null`, 'sh',
      process.execPath, path.join(ROOT, 'src', 'install', 'postinstall.mjs')],
      { env: { PATH: process.env.PATH, HOME: h, USERPROFILE: h }, encoding: 'utf8' });
    bug('X1', 'postinstall exits non-zero when stdout cannot be written (ENOSPC/EPIPE) — the write error escapes main()\'s catch',
      r.status !== 0,
      `exit ${r.status}; only package.json's "|| true" keeps npm install green, and cmd.exe has no /bin/true`);
    const pkgJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package.json still guards postinstall with || true', /\|\| true/.test(pkgJson.scripts.postinstall));
    ok('package.json still guards preuninstall with || true', /\|\| true/.test(pkgJson.scripts.preuninstall));
  }
}
{
  // The installer resolves the home with os.homedir(); the plan doctor reads
  // $HOME. They disagree whenever the two differ.
  const probe = spawnSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify({homedir:require("os").homedir(),env:process.env.HOME||null}))'],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const v = JSON.parse(probe.stdout);
  bug('H10', 'os.homedir() ignores an unset/empty HOME and falls back to /etc/passwd, so the installer can write to the REAL home of a sandboxed run',
    v.env === null && !!v.homedir,
    `HOME unset -> os.homedir()=${v.homedir}; harness-install.mjs:15 resolves HARNESS_DIRS at import time`);
  const doctorUsesEnvHome = /process\.env\.HOME \|\| ''/.test(readFileSync(path.join(ROOT, 'bin', 'surf-plan-skill.mjs'), 'utf8'));
  bug('H11', 'the plan doctor checks $HOME while the installer writes to os.homedir() — they disagree under sudo/containers',
    doctorUsesEnvHome,
    'bin/surf-plan-skill.mjs:145 uses process.env.HOME; harness-install.mjs:15 uses os.homedir()');
}

// ============================================== 6. check-surf-skill.mjs ===

section('check-surf-skill: counting usable keys off a MASKED keys list');
const { checkSurfSkill } = await import('../../src/lib/check-surf-skill.mjs');
const { gateStatus } = lib;
const PATH0 = process.env.PATH;
// The fixture CLI is a NODE script with an absolute shebang, and PATH is
// replaced by the fixture dir alone: the machine's real surf-research-skill
// can never be reached, and the script needs no external command to run.
function fakeCli(name, { versionLines = ['8.0.1'], keysJson = null, versionExit = 0 } = {}) {
  const dir = box(`bin-${name}`);
  const f = path.join(dir, 'surf-research-skill');
  const keysBody = keysJson === null
    ? `process.stderr.write('keys list is not supported by this build\\n'); process.exit(1);`
    : `process.stdout.write(${JSON.stringify(JSON.stringify(keysJson, null, 2) + '\n')});`;
  writeFileSync(f, [
    `#!${process.execPath}`,
    `const a = process.argv[2];`,
    `if (a === '--version') { process.stdout.write(${JSON.stringify(versionLines.join('\n') + '\n')}); process.exit(${versionExit}); }`,
    `if (a === 'keys') { ${keysBody} }`,
    `process.exit(0);`,
    '',
  ].join('\n'));
  chmodSync(f, 0o755);
  return dir;
}
const maskOf = (k) => k.slice(0, 5) + '…' + k.slice(-4);
const braveSection = (keys, extra = {}) => ({
  schema_version: 1, last_ok_provider: 'brave',
  brave: { keys: keys.map(maskOf), key_count: keys.length, current: 0, burned: [], cooldowns: [], validated: [], ...extra },
  openrouter: { keys: [], key_count: 0, current: 0, burned: [], cooldowns: [], validated: [] },
});
try {
  {
    process.env.PATH = fakeCli('healthy', { versionLines: ['8.0.1-fixture'], keysJson: braveSection(['BSA-aaaaaaaaaaa1', 'BSA-bbbbbbbbbb2', 'BSA-cccccccccc3'], { burned: [{ index: 1, at: new Date().toISOString(), reason: '401' }] }) });
    const r = await checkSurfSkill();
    ok('the CLI is detected', r.installed === true);
    // The distinctive suffix proves the FIXTURE ran, not the machine's install.
    eq('the version is read (and it is the fixture, not the real CLI)', r.version, '8.0.1-fixture');
    eq('masking does not break the total count', r.keyCounts.brave, 3);
    eq('masking does not break the usable count', r.keyCounts.braveUsable, 2);
  }
  {
    process.env.PATH = fakeCli('no-brave', { keysJson: { schema_version: 1, openrouter: { keys: [] } } });
    const r = await checkSurfSkill();
    ok('a keys.json with no brave section does not crash', r.installed === true);
    eq('...it just reports zero', r.keyCounts.braveUsable, 0);
  }
  {
    const state = { brave: { keys: ['BSA-real-and-fine'], current: 0, burned: [{ index: 7, at: new Date().toISOString(), reason: '401' }], cooldowns: [], validated: [] } };
    process.env.PATH = fakeCli('stale-burn', { keysJson: braveSection(['BSA-real-and-fine'], { burned: state.brave.burned }) });
    const r = await checkSurfSkill();
    const gate = gateStatus(state, 'brave');
    bug('K1', 'braveUsable is keys.length - burned.length, so a stale burn index reports 0 usable while the gate says the key is fine',
      r.keyCounts.braveUsable === 0 && gate.verdict !== 'burned',
      `braveUsable=${r.keyCounts.braveUsable}, gateStatus=${gate.verdict} — check-surf-skill.mjs:33; bin/surf-plan-skill.mjs:129 then sets exitCode 78 on a working install`);
  }
  {
    const burned = [{ index: 0, at: new Date().toISOString(), reason: '401' }, { index: 0, at: new Date().toISOString(), reason: '401' }];
    process.env.PATH = fakeCli('dup-burn', { keysJson: braveSection(['BSA-key-one-xxxx', 'BSA-key-two-xxxx'], { burned }) });
    const r = await checkSurfSkill();
    bug('K2', 'two burn records for the SAME index subtract twice — a ring with one usable key reports 0 usable',
      r.keyCounts.braveUsable === 0,
      `braveUsable=${r.keyCounts.braveUsable}; the count should be over distinct burned indices`);
  }
  {
    const validated = [{ index: 0, at: new Date().toISOString(), ok: false, status: 422, reason: 'invalid token' }];
    const state = { brave: { keys: ['BSA-known-bad-key'], current: 0, burned: [], cooldowns: [], validated } };
    process.env.PATH = fakeCli('known-bad', { keysJson: braveSection(['BSA-known-bad-key'], { validated }) });
    const r = await checkSurfSkill();
    const gate = gateStatus(state, 'brave');
    bug('K3', 'a key already PROVEN invalid still counts as usable — braveUsable ignores the cached validation verdict the gate trusts',
      r.keyCounts.braveUsable === 1 && gate.verdict === 'invalid',
      `braveUsable=${r.keyCounts.braveUsable} but gateStatus=${gate.verdict}: doctor reports healthy, the next search exits 78`);
  }
  {
    const until = new Date(Date.now() + 300_000).toISOString();
    const cooldowns = [{ index: 0, until }];
    const state = { brave: { keys: ['BSA-cooling-key-x'], current: 0, burned: [], cooldowns, validated: [] } };
    process.env.PATH = fakeCli('cooling', { keysJson: braveSection(['BSA-cooling-key-x'], { cooldowns }) });
    const r = await checkSurfSkill();
    const gate = gateStatus(state, 'brave');
    bug('K4', 'a rate-limited (cooling) key counts as usable — braveUsable ignores cooldowns',
      r.keyCounts.braveUsable === 1 && gate.verdict === 'cooling',
      `braveUsable=${r.keyCounts.braveUsable} but gateStatus=${gate.verdict}`);
  }
  {
    process.env.PATH = fakeCli('chatty', { versionLines: ['8.0.1', 'note: a newer version is available'], keysJson: braveSection([]) });
    const r = await checkSurfSkill();
    bug('K5', 'the version is read with .pop() — anything printed after it becomes the "version"',
      r.version !== '8.0.1',
      `reported version = ${JSON.stringify(r.version)}; check-surf-skill.mjs:23`);
  }
  {
    process.env.PATH = fakeCli('badjson', { keysJson: null });
    const r = await checkSurfSkill();
    ok('a CLI that cannot list keys is still reported as installed', r.installed === true);
    eq('...with keyCounts simply absent', r.keyCounts, undefined);
  }
  {
    process.env.PATH = box('empty-bin');
    const r = await checkSurfSkill();
    eq('an absent CLI is reported as not installed', r.installed, false);
    const csSrc = readFileSync(path.join(ROOT, 'src', 'lib', 'check-surf-skill.mjs'), 'utf8');
    bug('K6', 'the "not in PATH" hint is decided by grepping the SHELL\'s English error text, not the exec exit code (127)',
      /not found\|ENOENT/.test(csSrc),
      `on a localized shell the caller gets the raw stderr instead: ${JSON.stringify((r.error || '').split('\n')[0].slice(0, 80))}`);
  }
  {
    process.env.PATH = fakeCli('exit1', { versionExit: 1, keysJson: braveSection([]) });
    const r = await checkSurfSkill();
    eq('a CLI whose --version fails is reported as not installed', r.installed, false);
  }
} finally {
  process.env.PATH = PATH0;
}

// ---------------------------------------------------------------- summary ---

try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
for (const dir of hi.HARNESS_DIRS) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${bugs.length} bugs reproduced`);
process.stdout.write(fixed.length ? `, ${fixed.length} previously-known bugs now FIXED\n` : '\n');
if (bugs.length) {
  process.stdout.write('\nBUGS REPRODUCED (these do not fail the run — the fixing wave flips them):\n');
  for (const b of bugs) process.stdout.write(`  ⚠ ${b.id}  ${b.name}\n${b.detail ? '        ↳ ' + b.detail + '\n' : ''}`);
}
if (failures.length) {
  process.stdout.write('\nFAILURES:\n');
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('\nlib-install-ok\n');
