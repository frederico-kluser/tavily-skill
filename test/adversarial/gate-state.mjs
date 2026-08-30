#!/usr/bin/env node
// Adversarial tests for the key gate (src/lib/preflight.mjs) and the state
// layer (src/lib/state.mjs, src/lib/keys-cmd.mjs, the rotation half of
// src/lib/dispatch.mjs).
//
// This suite is hostile on purpose. It feeds the gate the keys.json shapes a
// real machine produces after a crash, a hand edit, a clock skew, a flaky
// hotel wifi, or two sub-agents writing at the same instant — and then asks
// the five questions that decide whether the "no key, no search" contract is
// actually a contract:
//
//   Q1  can the gate answer READY with a key that does not work?
//   Q2  can the gate answer INVALID/MISSING with a key that does work?
//   Q3  can removing one key move another key's verdict onto the wrong key?
//   Q4  does `keys ... --json` ever print a key in plain text?
//   Q5  does a corrupted keys.json stack-trace instead of degrading?
//
// Two kinds of assertion live here and they are counted separately:
//   ok()/eq() — behaviour that MUST hold. A failure fails the suite (exit 1).
//   bug()     — a defect proven to exist TODAY. It is reported, never fatal.
//              When the fix lands, bug() flips to "FIXED" on its own, so this
//              file doubles as the regression suite for the repair wave.
//
// NO NETWORK, EVER. Brave's monthly quota is nearly spent, so globalThis.fetch
// is replaced before the first import and throws unless a test has explicitly
// scripted a reply. HOME is re-pointed at a throwaway directory before any
// module that knows the path to ~/.config/surf/keys.json is loaded.
//
// Run: node ./test/adversarial/gate-state.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ------------------------------------------------------------- re-exec ---
// Same shape as test/brave.mjs: the parent only builds a throwaway HOME and
// re-execs, so nothing below this block can ever see the real keys.json.
if (!process.env.SURF_GATE_STATE_TEST_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-gate-state-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_GATE_STATE_TEST_CHILD: '1',
      SURF_GATE_STATE_TEST_HOME: home,
      SURF_QUIET: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      SURF_NO_RATE_LIMIT: '1',
      // Keep the burn/cooldown maths deterministic.
      SURF_RATE_LIMIT_COOLDOWN_MS: '60000',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

// ------------------------------------------------------- safety harness ---
// The single worst outcome of this file is deleting somebody's real Brave
// keys. Prove the sandbox before importing anything that can write.
const SANDBOX_HOME = process.env.SURF_GATE_STATE_TEST_HOME;
{
  const bad = [];
  if (!SANDBOX_HOME) bad.push('SURF_GATE_STATE_TEST_HOME is unset');
  if (homedir() !== SANDBOX_HOME) bad.push(`homedir() is ${homedir()}, not the sandbox`);
  if (!String(SANDBOX_HOME).startsWith(tmpdir())) bad.push(`sandbox ${SANDBOX_HOME} is not under ${tmpdir()}`);
  if (bad.length) {
    process.stderr.write(`REFUSING TO RUN — the sandbox is not sealed:\n  - ${bad.join('\n  - ')}\n`);
    process.exit(1);
  }
}

// No network. Not once. Every test that needs a reply installs `fetchPlan`.
let fetchPlan = null;
let fetchCalls = 0;
let lastToken = null;
globalThis.fetch = async (url, init = {}) => {
  fetchCalls++;
  lastToken = (init.headers || {})['X-Subscription-Token'];
  if (!fetchPlan) {
    const e = new Error('BLOCKED: this suite must never touch the network (Brave quota)');
    e.kind = 'network';
    throw e;
  }
  return fetchPlan(url, init);
};
/** Build the response shape src/lib/providers/brave.mjs expects. */
function reply({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: async () => JSON.stringify(body),
  };
}
const BRAVE_GOOD_KEY = { status: 422, body: { error: { code: 'VALIDATION', meta: { errors: [{ loc: ['query', 'q'] }] } } } };
const BRAVE_BAD_KEY = { status: 422, body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'nope' } } };
const BRAVE_RESULTS = { status: 200, body: { web: { results: [{ title: 't', url: 'https://example.com', description: 'd' }] }, query: {} } };
/** Answer every call with the same scripted reply. */
function always(spec) { fetchPlan = async () => reply(spec); }
/** Answer with each spec in turn, then repeat the last one. */
function sequence(specs) {
  const q = [...specs];
  let last = specs[specs.length - 1];
  fetchPlan = async () => reply(q.length ? (last = q.shift()) : last);
}
function offline() { fetchPlan = null; }

// ----------------------------------------------------------- reporting ---
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
/**
 * Report a defect without failing the suite.
 * @param id           stable identifier quoted in the handoff
 * @param name         what is wrong, in one line
 * @param stillBroken  true when the defective behaviour still reproduces
 */
function bug(id, name, stillBroken, evidence) {
  if (stillBroken) {
    bugs.push(`${id}  ${name}${evidence ? '\n        ' + evidence : ''}`);
    process.stdout.write(`  ⚠ BUG ${id} ${name}\n${evidence ? '      ' + evidence + '\n' : ''}`);
  } else {
    fixed.push(`${id}  ${name}`);
    process.stdout.write(`  ✓ BUG ${id} no longer reproduces (fixed): ${name}\n`);
  }
}
function section(t) { process.stdout.write(`\n${t}\n`); }
function threwSync(fn) {
  try { fn(); return null; } catch (e) { return e; }
}
async function threw(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

// ------------------------------------------------------------- imports ---
const S = await import('../../src/lib/state.mjs');
const PF = await import('../../src/lib/preflight.mjs');
const KC = await import('../../src/lib/keys-cmd.mjs');
const { dispatch } = await import('../../src/lib/dispatch.mjs');
const { GATE } = PF;

const REPO = path.resolve(path.dirname(SELF), '..', '..');
const KEYS_CLI = path.join(REPO, 'bin', 'surf-research-skill.mjs');

// One more seal, now that the module has computed the path for real.
ok('keys.json resolves inside the sandbox, not the user\'s home',
  S.KEYS_FILE.startsWith(SANDBOX_HOME), S.KEYS_FILE);

/** A provider section built by hand — exactly what a hand-edited file yields. */
const prov = (over = {}) => ({ ...S.blankProvider(), ...over });
/** Reset the on-disk state to a known brave section. */
async function seed(keys = [], over = {}) {
  const st = await S.loadState();
  st.brave = prov({ keys, ...over });
  st.openrouter = S.blankProvider();
  st.last_ok_provider = null;
  await S.saveStateAtomic(st);
  return st;
}

// =========================================================== THE GATE ===

section('gate: a keys.json section that is not shaped like a provider');
// loadState() normalises, so these shapes only reach gateStatus from a caller
// that builds state by hand — which is exactly the documented library entry
// (dispatch accepts runCtx.state) and every internal caller that spreads a
// partial object. The gate is the LAST line of defence and it must not crash.
{
  eq('a missing provider section is MISSING, not a crash',
    PF.gateStatus({}, 'brave').verdict, GATE.MISSING);

  const e1 = threwSync(() => PF.gateStatus({ brave: {} }, 'brave'));
  bug('G1', 'gateStatus() throws TypeError on a provider section without `keys`',
    e1 !== null && e1 instanceof TypeError,
    `src/lib/preflight.mjs:63 — gateStatus({brave:{}}) → ${e1 && e1.message}`);

  const e2 = threwSync(() => PF.gateStatus({ brave: { keys: ['k'] } }, 'brave'));
  bug('G2', 'gateStatus() throws TypeError on a section without `burned`',
    e2 !== null && e2 instanceof TypeError,
    `src/lib/preflight.mjs:67 — p.burned.map on undefined → ${e2 && e2.message}`);

  const e3 = threwSync(() => PF.gateStatus({ brave: { keys: 'a-string-not-an-array' } }, 'brave'));
  bug('G3', 'a non-array `keys` passes the emptiness check and crashes later',
    e3 !== null,
    `src/lib/preflight.mjs:63 — "abc".length is 3, so the MISSING guard lets a string through`);

  // The same partial shape reaches state.mjs helpers.
  const e4 = threwSync(() => S.providerHasUsableKey({ brave: { keys: ['k'] } }, 'brave'));
  bug('G4', 'providerHasUsableKey() crashes on the same partial shape',
    e4 !== null,
    `src/lib/state.mjs:254 — p.burned.map on undefined → ${e4 && e4.message}`);
}

section('gate: indices that point nowhere');
{
  const at = new Date().toISOString();
  eq('a burn on an index that no longer exists does not hide a live key',
    PF.gateStatus({ brave: prov({ keys: ['k'], burned: [{ index: 9, at }] }) }, 'brave').verdict, GATE.UNVALIDATED);
  eq('a negative burn index is inert',
    PF.gateStatus({ brave: prov({ keys: ['k'], burned: [{ index: -1, at }] }) }, 'brave').verdict, GATE.UNVALIDATED);
  eq('a cooldown with an unparseable date does not sideline the key',
    PF.gateStatus({ brave: prov({ keys: ['k'], cooldowns: [{ index: 0, until: 'not-a-date' }] }) }, 'brave').verdict, GATE.UNVALIDATED);
  eq('a validation verdict for an index that does not exist is ignored',
    PF.gateStatus({ brave: prov({ keys: ['k'], validated: [{ index: 5, at, ok: true }] }) }, 'brave').verdict, GATE.UNVALIDATED);
  // normalizeProvider drops empty strings, but a hand-built state keeps them.
  eq('an empty-string key still counts as a key to the gate',
    PF.gateStatus({ brave: prov({ keys: [''] }) }, 'brave').verdict, GATE.UNVALIDATED);
  ok('and the gate would spend a probe on it',
    PF.gateStatus({ brave: prov({ keys: [''] }) }, 'brave').index === 0);
}

section('gate: burned AND cooling at the same time');
{
  const at = new Date().toISOString();
  const st = { brave: prov({
    keys: ['burned-one', 'cooling-one'],
    burned: [{ index: 0, at, reason: '401' }],
    cooldowns: [{ index: 1, until: new Date(Date.now() + 60_000).toISOString() }],
  }) };
  const g = PF.gateStatus(st, 'brave');
  eq('burned is checked first, then cooling — the survivor decides', g.verdict, GATE.COOLING);
  ok('and the message names the moment it lifts', /until 20\d\d-/.test(g.detail), g.detail);

  const allBurned = { brave: prov({ keys: ['a', 'b'], burned: [{ index: 0, at, reason: '401' }, { index: 1, at, reason: '401' }] }) };
  eq('every key burned is BURNED', PF.gateStatus(allBurned, 'brave').verdict, GATE.BURNED);
  ok('and it quotes the auto-reset date rather than telling you to buy a key',
    PF.gateStatus(allBurned, 'brave').detail.includes('auto-resets'));
}

section('gate: order matters — one good key hidden behind a bad one');
{
  const mk = () => ({ brave: prov({ keys: ['proven-bad', 'proven-good'] }) });
  const a = mk();
  S.setValidation(a, 'brave', 0, { ok: false, reason: 'bad' });
  S.setValidation(a, 'brave', 1, { ok: true });
  eq('a bad key at index 0 does not mask a good key at index 1', PF.gateStatus(a, 'brave').verdict, GATE.READY);
  eq('and the good index is the one reported', PF.gateStatus(a, 'brave').index, 1);

  const b = { brave: prov({ keys: ['proven-good', 'proven-bad'] }) };
  S.setValidation(b, 'brave', 0, { ok: true });
  S.setValidation(b, 'brave', 1, { ok: false, reason: 'bad' });
  eq('the reverse order agrees', PF.gateStatus(b, 'brave').index, 0);

  const c = { brave: prov({ keys: ['x', 'y'] }) };
  S.setValidation(c, 'brave', 0, { ok: false, reason: 'bad' });
  S.setValidation(c, 'brave', 1, { ok: false, reason: 'bad' });
  eq('all keys proven bad is INVALID, never UNVALIDATED', PF.gateStatus(c, 'brave').verdict, GATE.INVALID);
}

section('gate: Q1 — READY for a key that does not work');
{
  // A verdict stamped in the future never ages out: getValidation compares
  // (now - at) > TTL, and a negative age is never greater than the TTL. The
  // same arithmetic in normalizeProvider keeps it across every save. One
  // clock skew, or one hand edit, and the key is trusted forever.
  const st = { brave: prov({ keys: ['revoked-months-ago'] }) };
  S.setValidation(st, 'brave', 0, { ok: true });
  st.brave.validated[0].at = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
  const g = PF.gateStatus(st, 'brave');
  offline();
  const live = await PF.resolveGate(st, 'brave', { persist: false });
  bug('P1', 'a validation verdict dated in the future never expires — the gate trusts it forever',
    g.verdict === GATE.READY && live.verdict === GATE.READY,
    'src/lib/state.mjs:127 (Date.now()-at > TTL) and :101 (now-at < TTL) both accept a negative age');
  const roundTripLen = await (async () => {
    await seed(['revoked-months-ago']);
    const disk = await S.loadState();
    S.setValidation(disk, 'brave', 0, { ok: true });
    disk.brave.validated[0].at = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
    await S.saveStateAtomic(disk);
    return ((await S.loadState()).brave.validated || []).length;
  })();
  // NOT a contract. This used to be an ok(), and its own description — a
  // "poisoned verdict" SURVIVING a round-trip through keys.json — asserted
  // the P1 defect as if it were correct behaviour: no implementation can
  // both fix P1 (a verdict stamped beyond the TTL in the future must not be
  // trusted) and keep that entry alive through a save. The condition is
  // UNCHANGED; `roundTripLen === 1` reads as FIXED instead of failing the
  // suite (the same conversion the audit applied to BUG-21b).
  bug('P1b', 'the SAME defect as P1 reached through its second entry point: a poisoned verdict survives a round-trip through keys.json',
    roundTripLen === 1,
    `src/lib/state.mjs:197 prunes it (validationAge discards a stamp beyond the TTL ahead) → validated.length=${roundTripLen} after the round-trip`);
}
{
  // allowLive:false converts "we have never checked this key" into READY.
  // No bin passes it today, but it is an exported, documented option and
  // assertProviderReady() lets it through the hard stop.
  const st = { brave: prov({ keys: ['never-checked-garbage'] }) };
  offline();
  const r = await PF.resolveGate(st, 'brave', { allowLive: false, persist: false });
  const passedGate = await threw(() => PF.assertProviderReady(st, 'brave', { allowLive: false, persist: false }));
  bug('P2', 'resolveGate({allowLive:false}) reports READY for a key that was never validated',
    r.verdict === GATE.READY && passedGate === null,
    'src/lib/preflight.mjs:123 — presence is reported with the same verdict word as proof');
}

section('gate: Q2 — INVALID for a key that works');
{
  // THE HEADLINE. brave.validate() answers a dropped connection with
  // {valid:false, kind:'network'}. resolveGate does not look at the kind: it
  // writes ok:false straight into the 7-day cache. From then on the key is
  // INVALID with no re-probe, and the message tells the user to delete it.
  const st = { brave: prov({ keys: ['a-perfectly-good-key'] }) };
  offline();                                   // the wifi dropped
  const first = await PF.resolveGate(st, 'brave', { persist: false });
  const cached = S.getValidation(st, 'brave', 0);

  always(BRAVE_GOOD_KEY);                      // the wifi came back
  const before = fetchCalls;
  const second = await PF.resolveGate(st, 'brave', { persist: false });
  const reprobes = fetchCalls - before;

  bug('P3', 'ONE network blip caches "invalid key" for 7 days and the gate never re-probes',
    first.verdict === GATE.INVALID && cached && cached.ok === false && second.verdict === GATE.INVALID && reprobes === 0,
    'src/lib/preflight.mjs:144-147 stores ok:false for kind=network; :142 then `continue`s past it for the whole TTL');

  const msg = PF.formatGate(second.verdict, second.detail, 'brave').text;
  bug('P4', 'and the advice for that live key is to delete it',
    msg.includes('keys remove') && !msg.includes('keys reset'),
    'src/lib/preflight.mjs:191-196 — the INVALID fix never mentions `keys reset`, the one command that clears the verdict');

  // A Brave outage does the same thing.
  const st2 = { brave: prov({ keys: ['good-key-during-outage'] }) };
  always({ status: 503, body: { error: { code: 'INTERNAL' } } });
  const r2 = await PF.resolveGate(st2, 'brave', { persist: false });
  bug('P5', 'a Brave 5xx outage is also cached as a permanently invalid key',
    r2.verdict === GATE.INVALID && (S.getValidation(st2, 'brave', 0) || {}).ok === false,
    'src/lib/preflight.mjs:145 — every non-valid verdict is cached, transient or not');

  // And with persist on (the default from preflightOrExit) it reaches disk.
  await seed(['key-that-outlives-the-outage']);
  const disk = await S.loadState();
  offline();
  await PF.resolveGate(disk, 'brave');
  const back = await S.loadState();
  bug('P6', 'the poisoned verdict is written to keys.json, so it survives the reboot that fixes the wifi',
    (back.brave.validated || []).some(v => v.index === 0 && v.ok === false),
    'src/lib/preflight.mjs:156 saves the cache unconditionally');

  // The escape hatch exists, it is just never named.
  await KC.keysReset([], { provider: 'brave' });
  const healed = await S.loadState();
  eq('`keys reset` does clear the poisoned verdict', (healed.brave.validated || []).length, 0);
}

section('gate: the key the gate proves is not the key dispatch uses');
{
  // gateStatus returns the index of the key it trusts. dispatch ignores it and
  // starts its own rotation at p.current, so READY does not mean "the next
  // request goes out on a proven key".
  const st = await S.loadState();
  st.brave = prov({ keys: ['NEVER-CHECKED', 'PROVEN-GOOD'], current: 0 });
  S.setValidation(st, 'brave', 1, { ok: true });
  st._inMemory = true;
  const g = PF.gateStatus(st, 'brave');
  const used = [];
  fetchPlan = async (url, init) => {
    used.push((init.headers || {})['X-Subscription-Token']);
    return reply(used.length === 1 ? BRAVE_BAD_KEY : BRAVE_RESULTS);
  };
  await dispatch('search', { query: 'hi' }, { 'no-cache': true }, { state: st });
  bug('D1', 'the gate blesses key #1 and dispatch still spends the next request on unproven key #0',
    g.index === 1 && used[0] === 'NEVER-CHECKED',
    `src/lib/preflight.mjs:91 returns index ${g.index}; src/lib/dispatch.mjs:186-201 restarts from p.current and ignores it`);
  ok('the ring does self-heal afterwards — the bad key is burned and #1 answers',
    st.brave.burned.map(b => b.index).join() === '0' && used[1] === 'PROVEN-GOOD');
}

section('gate: formatGate speaks all four verdicts');
for (const [v, expect] of [[GATE.MISSING, 'keys add'], [GATE.BURNED, 'keys reset'], [GATE.COOLING, 'wait'], [GATE.INVALID, 'keys remove']]) {
  const { code, text } = PF.formatGate(v, 'detail here', 'brave');
  ok(`${v}: a stable machine-readable code`, /^BraveKey/.test(code), code);
  ok(`${v}: an actionable fix (${expect})`, text.includes(expect), text.split('\n')[2]);
  ok(`${v}: the detail is quoted verbatim`, text.includes('detail here'));
  ok(`${v}: and the Brave-only contract is restated`, text.includes('never quietly answer'));
}
{
  const { code, text } = PF.formatGate('a-verdict-that-does-not-exist', '', 'brave');
  eq('an unknown verdict degrades to the missing-key code', code, 'BraveKeyMissing');
  ok('and still produces a message', text.length > 0);
  eq('an UNVALIDATED verdict has no message of its own', PF.formatGate(GATE.UNVALIDATED, '', 'brave').code, 'BraveKeyMissing');
}

section('gate: assertProviderReady and preflightOrExit');
{
  offline();
  const e = await threw(() => PF.assertProviderReady({ brave: S.blankProvider() }, 'brave', { persist: false }));
  ok('an empty pool throws instead of returning a degraded result', e !== null);
  eq('with exit 78', e.exitCode, PF.EXIT_CONFIG);
  eq('EX_CONFIG is 78, distinct from 1 and 2', PF.EXIT_CONFIG, 78);
  eq('and a stable code', e.code, 'BraveKeyMissing');
  ok('the verdict is carried in details for programmatic callers', e.details.verdict === GATE.MISSING);

  const st = { brave: prov({ keys: ['good'] }) };
  S.setValidation(st, 'brave', 0, { ok: true });
  const r = await PF.assertProviderReady(st, 'brave', { persist: false });
  eq('a cached-good key passes the gate', r.verdict, GATE.READY);
  eq('and it costs no request', fetchPlan, null);
}
{
  // preflightOrExit calls process.exit, so it has to run in a child.
  const runPreflight = (setup) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFile, mkdir } from 'node:fs/promises';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    globalThis.fetch = async () => { throw new Error('no network'); };
    await mkdir(join(homedir(), '.config', 'surf'), { recursive: true });
    ${setup}
    const { preflightOrExit } = await import('${path.join(REPO, 'src/lib/preflight.mjs')}');
    await preflightOrExit();
    console.log('GATE-PASSED');
  `], { encoding: 'utf8', env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME } });

  const empty = runPreflight(`await writeFile(join(homedir(), '.config', 'surf', 'keys.json'), '{}');`);
  eq('preflightOrExit exits 78 with no key', empty.status, 78);
  ok('and prints the canonical error to stderr', empty.stderr.includes('BraveKeyMissing'), empty.stderr.slice(0, 120));
  ok('and nothing at all to stdout', empty.stdout.trim() === '', empty.stdout);

  // Q5: a corrupted keys.json.
  const corrupt = runPreflight(`await writeFile(join(homedir(), '.config', 'surf', 'keys.json'), '{ this is not json');`);
  eq('a corrupted keys.json still exits 78, not 1', corrupt.status, 78);
  ok('Q5: it never stack-traces', !/at .*\.mjs:\d+/.test(corrupt.stderr), corrupt.stderr.slice(0, 200));
  bug('P7', 'a corrupted keys.json is reported as "no key configured", hiding the real cause',
    corrupt.stderr.includes('BraveKeyMissing') && !corrupt.stderr.toLowerCase().includes('could not read') && !corrupt.stderr.toLowerCase().includes('corrupt'),
    'src/lib/state.mjs:226 swallows the parse error, so preflight.mjs:240 (the "could not read" branch) is unreachable');
}

// ========================================================== THE STATE ===

section('state: Q5 — every shape of a broken keys.json degrades to empty');
{
  const shapes = [
    ['truncated mid-write', '{"brave":{"keys":["abc"]'],
    ['not JSON at all', '{ this is not json'],
    ['a top-level array', '[]'],
    ['a literal null', 'null'],
    ['a bare string', '"hello"'],
    ['a bare number', '42'],
    ['keys as an object', '{"brave":{"keys":{"0":"k"}}}'],
    ['keys holding non-strings', '{"brave":{"keys":[1,null,{"a":1},"real-key"]}}'],
    ['an empty file', ''],
  ];
  for (const [label, txt] of shapes) {
    await writeFile(S.KEYS_FILE, txt);
    const e = await threw(() => S.loadState());
    ok(`${label}: loadState does not throw`, e === null, e && e.message);
    const st = await S.loadState();
    ok(`${label}: every provider section is rebuilt`,
      Array.isArray(st.brave.keys) && Array.isArray(st.brave.burned) && Array.isArray(st.openrouter.validated));
  }
  await writeFile(S.KEYS_FILE, '{"brave":{"keys":[1,null,{"a":1},"real-key"]}}');
  const filtered = await S.loadState();
  eq('non-string keys are dropped, the real one survives', filtered.brave.keys.join(), 'real-key');
}
{
  // Degrading is right. Silently overwriting is not: the blank state goes
  // straight back to disk on the next write, and the only copy of the keys
  // is gone. Compare rescueLegacyProviderKeys, which refuses to do this.
  await writeFile(S.KEYS_FILE, '{ CORRUPT but it still contains BSA-the-only-copy-of-my-key');
  const st = await S.loadState();
  await S.saveStateAtomic(st);
  const after = await readFile(S.KEYS_FILE, 'utf8');
  bug('S1', 'a corrupted keys.json is silently overwritten by the next save — the keys inside are unrecoverable',
    !after.includes('BSA-the-only-copy-of-my-key'),
    'src/lib/state.mjs:226 falls back to blankState() without copying the unparseable file aside');
}

section('state: normalizeProvider is a whitelist, and that is load-bearing');
{
  await seed(['whitelist-key']);
  const st = await S.loadState();
  st.brave.note = 'a field a future version might add';
  st.brave.validated = [{ index: 0, at: new Date().toISOString(), ok: true, status: 200, custom: 'dropped' }];
  await S.saveStateAtomic(st);
  const back = await S.loadState();
  eq('an unknown provider field does not survive a round-trip', back.brave.note, undefined);
  eq('validated does survive (a regression that made the cache a no-op)', back.brave.validated.length, 1);
  eq('and its verdict is intact', back.brave.validated[0].ok, true);
  eq('nested extras inside a whitelisted array DO survive', back.brave.validated[0].custom, 'dropped');
  eq('last_ok_provider is checked against PROVIDERS', (await (async () => {
    const s = await S.loadState(); s.last_ok_provider = 'tavily'; await S.saveStateAtomic(s);
    return (await S.loadState()).last_ok_provider;
  })()), null);
}

section('state: the validation TTL, at the exact boundary');
{
  const TTL = S.VALIDATION_TTL_MS;
  const mk = (age) => ({ brave: prov({ keys: ['k'], validated: [{ index: 0, at: new Date(Date.now() - age).toISOString(), ok: true }] }) });
  ok('one ms inside the TTL is a hit', S.getValidation(mk(TTL - 1), 'brave', 0) !== null);
  ok('one ms past the TTL is a miss', S.getValidation(mk(TTL + 1), 'brave', 0) === null);

  const atExactly = mk(TTL);
  const inMemory = S.getValidation(atExactly, 'brave', 0) !== null;
  await seed(['k']);
  const disk = await S.loadState();
  disk.brave.validated = [{ index: 0, at: new Date(Date.now() - TTL).toISOString(), ok: true }];
  await S.saveStateAtomic(disk);
  const survived = ((await S.loadState()).brave.validated || []).length === 1;
  bug('S2', 'the two TTL comparisons disagree at exactly TTL: getValidation says hit, normalizeProvider prunes it',
    inMemory === true && survived === false,
    'src/lib/state.mjs:127 uses `> TTL` while :101 uses `< TTL` — the same entry is live in memory and dead on disk');

  const noAt = { brave: prov({ keys: ['k'], validated: [{ index: 0, ok: true }] }) };
  ok('a verdict with no timestamp is not trusted', S.getValidation(noAt, 'brave', 0) === null);
  const junkAt = { brave: prov({ keys: ['k'], validated: [{ index: 0, at: 'yesterday-ish', ok: true }] }) };
  ok('a verdict with an unparseable timestamp is not trusted', S.getValidation(junkAt, 'brave', 0) === null);
}

section('state: setValidation / clearValidation');
{
  const st = { brave: prov({ keys: ['a', 'b'] }) };
  S.setValidation(st, 'brave', 0, { ok: true, status: 200 });
  S.setValidation(st, 'brave', 0, { ok: false, reason: 'revoked' });
  eq('re-validating the same index overwrites, never duplicates', st.brave.validated.length, 1);
  eq('and the newest verdict wins', st.brave.validated[0].ok, false);
  S.setValidation(st, 'brave', 1, { ok: true });
  S.clearValidation(st, 'brave', 0);
  eq('clearing one index leaves the other', st.brave.validated.length, 1);
  eq('and it is the right one', st.brave.validated[0].index, 1);
  S.clearValidation(st, 'brave');
  eq('clearing with no index wipes the section', st.brave.validated.length, 0);
  ok('clearing on a missing provider is a no-op, not a crash', threwSync(() => S.clearValidation({}, 'brave', 0)) === null);
  ok('setting on a missing provider is a no-op, not a crash', threwSync(() => S.setValidation({}, 'brave', 0, { ok: true })) === null);
}

section('state: markBurned / clearBurned');
{
  const st = { brave: prov({ keys: ['a', 'b'] }) };
  S.setValidation(st, 'brave', 0, { ok: true });
  S.markBurned(st, 'brave', 0, '401');
  eq('a burn drops the cached good verdict — live proof beats a week-old cache', st.brave.validated.length, 0);
  S.markBurned(st, 'brave', 0, '403');
  eq('burning the same index twice does not duplicate the entry', st.brave.burned.length, 1);
  eq('and keeps the first reason', st.brave.burned[0].reason, '401');
  ok('the burn is timestamped', !Number.isNaN(new Date(st.brave.burned[0].at).getTime()));
  S.markBurned(st, 'brave', 1, undefined);
  eq('a missing reason becomes "unknown"', st.brave.burned[1].reason, 'unknown');
  ok('burning on a missing provider is a no-op, not a crash', threwSync(() => S.markBurned({}, 'brave', 0, 'x')) === null);

  const capped = { brave: prov({ keys: ['a'] }) };
  for (let i = 0; i < 80; i++) S.markBurned(capped, 'brave', i, 'x');
  ok('the burned list is capped', capped.brave.burned.length <= 50, String(capped.brave.burned.length));
  eq('and the cap drops the OLDEST burn, not the newest', capped.brave.burned[capped.brave.burned.length - 1].index, 79);

  const e = threwSync(() => S.clearBurned({}, 'brave'));
  bug('S3', 'clearBurned() throws TypeError when the provider section is absent',
    e !== null && e instanceof TypeError,
    `src/lib/state.mjs:308 — state[provider].burned = [] on undefined → ${e && e.message}`);
  const e2 = threwSync(() => S.clearBurned({}));
  bug('S4', 'clearBurned() with no provider throws on the first missing section',
    e2 !== null, 'src/lib/state.mjs:309 — the same unguarded assignment inside the PROVIDERS loop');
}

section('state: the monthly un-burn, across the year boundary');
{
  await seed(['k'], { burned: [{ index: 0, at: '2025-12-31T23:59:59.000Z', reason: '401' }] });
  eq('a December burn is cleared once the year rolls over', (await S.loadState()).brave.burned.length, 0);

  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12)).toISOString();
  await seed(['k'], { burned: [{ index: 0, at: thisMonth, reason: '401' }] });
  eq('a burn from THIS month survives the load', (await S.loadState()).brave.burned.length, 1);

  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12)).toISOString();
  await seed(['k'], { burned: [{ index: 0, at: lastMonth, reason: '401' }] });
  eq('a burn from last month is cleared', (await S.loadState()).brave.burned.length, 0);

  await seed(['k'], { burned: [{ index: 0, at: thisMonth, reason: '401' }] });
  eq('skipMonthlyReset keeps it for callers that want the raw file',
    (await S.loadState({ skipMonthlyReset: true })).brave.burned.length, 1);

  // A burn without a timestamp is not merely un-resettable — it evaporates.
  await seed(['k'], { burned: [{ index: 0 }] });
  const gone = (await S.loadState()).brave.burned.length === 0;
  bug('S5', 'a burn entry with no (or unparseable) `at` silently un-burns itself on the next load',
    gone,
    'src/lib/state.mjs:86 admits {index} with no `at`; :159 then treats NaN as "reset me"');
}

section('state: nextResetIso');
{
  eq('a December burn resets on 1 January', S.nextResetIso('2025-12-31T23:59:59.000Z'), '2026-01-01T00:00:00.000Z');
  eq('a January burn resets on 1 February', S.nextResetIso('2026-01-01T00:00:00.000Z'), '2026-02-01T00:00:00.000Z');
  eq('the 31st of a 31-day month does not overflow', S.nextResetIso('2026-01-31T00:00:00.000Z'), '2026-02-01T00:00:00.000Z');
  eq('an unparseable date is an em dash, not "Invalid Date"', S.nextResetIso('nope'), '—');
  eq('undefined is an em dash too', S.nextResetIso(undefined), '—');
  eq('an empty string is an em dash too', S.nextResetIso(''), '—');
  // null is not undefined: new Date(null) is the epoch, and the epoch parses.
  bug('S9', 'nextResetIso(null) quotes 1 February 1970 as the date a burned key comes back',
    S.nextResetIso(null) === '1970-02-01T00:00:00.000Z',
    'src/lib/state.mjs:115 — Number.isNaN(new Date(null)) is false, so the em-dash guard is bypassed; preflight.mjs:75 prints it to the user');
}

section('state: cooldowns');
{
  const st = { brave: prov({ keys: ['a'] }) };
  const until = Date.now() + 60_000;
  S.setCooldown(st, 'brave', 0, until);
  ok('a cooldown in the future is active', S.cooldownActive(st.brave, 0));
  S.setCooldown(st, 'brave', 0, Date.now() + 120_000);
  eq('setting it twice updates in place', st.brave.cooldowns.length, 1);
  S.setCooldown(st, 'brave', 0, Date.now() - 1000);
  ok('a cooldown in the past is not active', !S.cooldownActive(st.brave, 0));
  ok('an unknown index is not cooling', !S.cooldownActive(st.brave, 7));
  ok('a section with no cooldowns array is not cooling', !S.cooldownActive({ keys: ['a'] }, 0));
  ok('an unparseable `until` is not cooling', !S.cooldownActive({ cooldowns: [{ index: 0, until: 'soon' }] }, 0));
  ok('setting on a missing provider is a no-op', threwSync(() => S.setCooldown({}, 'brave', 0, until)) === null);

  await seed(['a'], { cooldowns: [{ index: 0, until: new Date(Date.now() - 1000).toISOString() }] });
  eq('expired cooldowns are pruned on load', (await S.loadState()).brave.cooldowns.length, 0);

  const e = threwSync(() => S.setCooldown({ brave: prov() }, 'brave', 0, NaN));
  bug('S6', 'setCooldown() throws RangeError on an unparseable timestamp instead of ignoring it',
    e !== null && e instanceof RangeError,
    `src/lib/state.mjs:282 — new Date(NaN).toISOString() → ${e && e.message}`);
}

section('state: explainUnusable covers every branch');
{
  const at = new Date().toISOString();
  eq('no keys → add one', S.explainUnusable({ brave: S.blankProvider() }, 'brave').fix.includes('keys add'), true);
  eq('a missing section is treated as no keys', S.explainUnusable({}, 'brave').reason, 'no key configured');
  const burned = S.explainUnusable({ brave: prov({ keys: ['a'], burned: [{ index: 0, at, reason: '401' }] }) }, 'brave');
  ok('all burned → reset, not "add another key"', burned.fix.includes('keys reset'), burned.fix);
  ok('and it quotes the auto-reset date', burned.reason.includes('auto-resets'));
  const cooling = S.explainUnusable({ brave: prov({ keys: ['a'], cooldowns: [{ index: 0, until: new Date(Date.now() + 60_000).toISOString() }] }) }, 'brave');
  ok('all cooling → wait or widen the budget', cooling.fix.includes('wait'), cooling.fix);
  eq('a usable key returns null (nothing to explain)', S.explainUnusable({ brave: prov({ keys: ['a'] }) }, 'brave'), null);
  eq('one cooling of two is still usable', S.explainUnusable({ brave: prov({ keys: ['a', 'b'], cooldowns: [{ index: 0, until: new Date(Date.now() + 60_000).toISOString() }] }) }, 'brave'), null);
}

section('state: nextUsableKeyIndex');
{
  const at = new Date().toISOString();
  eq('an empty pool is -1', S.nextUsableKeyIndex({ brave: S.blankProvider() }, 'brave'), -1);
  eq('rotation starts at current', S.nextUsableKeyIndex({ brave: prov({ keys: ['a', 'b', 'c'], current: 1 }) }, 'brave'), 1);
  eq('and wraps past a burned key', S.nextUsableKeyIndex({ brave: prov({ keys: ['a', 'b'], current: 1, burned: [{ index: 1, at }] }) }, 'brave'), 0);
  eq('skipIndex is honoured', S.nextUsableKeyIndex({ brave: prov({ keys: ['a', 'b'] }) }, 'brave', 0), 1);
  eq('an out-of-range current is clamped, not fatal', S.nextUsableKeyIndex({ brave: prov({ keys: ['a', 'b'], current: 99 }) }, 'brave'), 1);
  eq('a negative current is clamped to 0', S.nextUsableKeyIndex({ brave: prov({ keys: ['a', 'b'], current: -5 }) }, 'brave'), 0);
  eq('everything burned is -1', S.nextUsableKeyIndex({ brave: prov({ keys: ['a'], burned: [{ index: 0, at }] }) }, 'brave'), -1);
}

section('state: the legacy-key rescue promises more than it delivers');
{
  const day = new Date().toISOString().slice(0, 10);
  const rescueFile = path.join(S.CONFIG_DIR, `keys.legacy-${day}.json`);
  await rm(rescueFile, { force: true });

  const withLegacy = (tavilyKey) => JSON.stringify({
    brave: { keys: ['b1'], current: 0, burned: [], cooldowns: [], validated: [] },
    tavily: { keys: [tavilyKey] },
  });

  await writeFile(S.KEYS_FILE, withLegacy('TAVILY-BATCH-ONE'));
  await S.loadState();
  const firstRescue = await readFile(rescueFile, 'utf8');
  ok('the first run really does copy the abandoned keys out', firstRescue.includes('TAVILY-BATCH-ONE'));

  // Second run, same day, different legacy keys — e.g. the user restored a
  // backup, or has two machines syncing this directory.
  await writeFile(S.KEYS_FILE, withLegacy('TAVILY-BATCH-TWO'));
  await S.loadState();
  const secondRescue = await readFile(rescueFile, 'utf8');
  await S.saveStateAtomic(await S.loadState());
  const keysNow = await readFile(S.KEYS_FILE, 'utf8');
  bug('S7', 'a second rescue on the same day is skipped, yet still reports success — and the next save deletes the keys',
    !secondRescue.includes('TAVILY-BATCH-TWO') && !keysNow.includes('TAVILY-BATCH-TWO'),
    'src/lib/state.mjs:359 short-circuits on existsSync but :361 returns the path anyway, so loadState prints "nothing was destroyed"');
  await rm(rescueFile, { force: true });
  await seed([]);
}

section('state: saveStateAtomic locks the write, not the read-modify-write');
{
  // surf v8 exists to run many sub-agent PROCESSES at once, and each of them
  // calls saveStateAtomic on a burn, a cooldown or a fresh verdict. The
  // lockfile serialises the file replacement, but every writer serialises its
  // own whole-file snapshot, so the last one to finish erases the others.
  await seed(['K0']);
  const agent1 = await S.loadState();
  const agent2 = await S.loadState();
  agent1.brave.keys.push('ADDED-BY-AGENT-1');
  await S.saveStateAtomic(agent1);
  S.markBurned(agent2, 'brave', 0, '401');
  await S.saveStateAtomic(agent2);
  const final = await S.loadState();
  bug('S8', 'concurrent writers clobber each other: a key added by one process vanishes when another saves',
    !final.brave.keys.includes('ADDED-BY-AGENT-1'),
    'src/lib/state.mjs:236-249 — acquireLock() wraps only the write; loadState→mutate→save is unguarded');
  ok('the survivor is internally consistent, at least', final.brave.burned.length === 1);

  // The lock itself does recover from a crashed holder.
  await writeFile(S.LOCK_FILE, 'stale');
  const t0 = Date.now();
  await S.saveStateAtomic(await S.loadState());
  ok('a stale lockfile is broken rather than deadlocking forever', Date.now() - t0 < 8000);
  await rm(S.LOCK_FILE, { force: true });
  await seed([]);
}

// =========================================================== KEYS CMD ===

const SKIP = { provider: 'brave', 'skip-validate': true };

section('keys add: duplicates, junk and volume');
{
  await seed([]);
  const dup = await KC.keysAdd(['DUP', 'DUP'], SKIP);
  eq('a key repeated in one call is added once', dup.addedCount, 1);
  const again = await KC.keysAdd(['DUP'], SKIP);
  eq('adding an existing key adds nothing', again.addedCount, 0);
  eq('and says why', again.results[0].reason, 'already exists');
  eq('the pool still holds one key', (await S.loadState()).brave.keys.length, 1);

  ok('an empty key is a usage error, not a stored empty string',
    (await threw(() => KC.keysAdd([''], SKIP))) !== null);
  ok('a whitespace-only key is a usage error too',
    (await threw(() => KC.keysAdd(['   '], SKIP))) !== null);
  ok('no positional at all is a usage error',
    (await threw(() => KC.keysAdd([], SKIP))) !== null);
  ok('an unknown provider is rejected',
    (await threw(() => KC.keysAdd(['k'], { provider: 'tavily', 'skip-validate': true }))) !== null);
  ok('a missing --provider is rejected',
    (await threw(() => KC.keysAdd(['k'], { 'skip-validate': true }))) !== null);

  await seed([]);
  const many = Array.from({ length: 200 }, (_, i) => `KEY-${i}`);
  const bulk = await KC.keysAdd(many, SKIP);
  eq('200 keys all land', bulk.addedCount, 200);
  const disk = await S.loadState();
  eq('and all 200 survive the save', disk.brave.keys.length, 200);
  eq('in order', disk.brave.keys[199], 'KEY-199');

  // Index attribution when some keys in a batch are rejected by validation.
  await seed([]);
  const seenTokens = [];
  fetchPlan = async (url, init) => {
    const tok = (init.headers || {})['X-Subscription-Token'];
    seenTokens.push(tok);
    return reply(tok === 'BATCH-BAD' ? BRAVE_BAD_KEY : BRAVE_GOOD_KEY);
  };
  const mixed = await KC.keysAdd(['BATCH-GOOD-A', 'BATCH-BAD', 'BATCH-GOOD-B'], { provider: 'brave' });
  const st = await S.loadState();
  eq('the invalid key is refused', mixed.addedCount, 2);
  eq('the good keys are stored', st.brave.keys.join(), 'BATCH-GOOD-A,BATCH-GOOD-B');
  eq('and each verdict is filed against the index it was actually stored at',
    (st.brave.validated || []).map(v => `${v.index}:${v.ok}`).sort().join(), '0:true,1:true');
  offline();
}

section('keys remove: Q3 — does a verdict follow the right key?');
{
  // The one that matters. Remove key 0 while key 1 carries the only proven
  // verdict; the verdict must land on the key that is still there.
  await seed(['KEY-A', 'KEY-B']);
  {
    const st = await S.loadState();
    S.setValidation(st, 'brave', 0, { ok: false, reason: 'bad' });
    S.setValidation(st, 'brave', 1, { ok: true, status: 200 });
    S.setCooldown(st, 'brave', 1, Date.now() + 60_000);
    st.brave.burned = [];
    await S.saveStateAtomic(st);
  }
  await KC.keysRemove(['0'], { provider: 'brave' });
  const after = await S.loadState();
  eq('the right key is gone', after.brave.keys.join(), 'KEY-B');
  eq('exactly one verdict remains', (after.brave.validated || []).length, 1);
  eq('it is re-indexed onto the surviving key', after.brave.validated[0].index, 0);
  eq('and it is KEY-B\'s verdict, not the deleted key\'s', after.brave.validated[0].ok, true);
  eq('the cooldown is re-indexed the same way', after.brave.cooldowns[0].index, 0);

  // And a burn below the removed index must not shift.
  await seed(['A', 'B', 'C']);
  {
    const st = await S.loadState();
    S.markBurned(st, 'brave', 0, '401');
    S.setValidation(st, 'brave', 2, { ok: true });
    await S.saveStateAtomic(st);
  }
  await KC.keysRemove(['1'], { provider: 'brave' });
  const mid = await S.loadState();
  eq('removing the middle key keeps the burn on A', mid.brave.burned[0].index, 0);
  eq('and moves C\'s verdict down with C', mid.brave.validated[0].index, 1);
  eq('C is where the verdict says it is', mid.brave.keys[1], 'C');

  // Removing the key that owns the verdict must delete the verdict.
  await seed(['A', 'B']);
  {
    const st = await S.loadState();
    S.setValidation(st, 'brave', 0, { ok: true });
    await S.saveStateAtomic(st);
  }
  await KC.keysRemove(['0'], { provider: 'brave' });
  eq('the removed key\'s verdict is deleted, not inherited by its successor',
    ((await S.loadState()).brave.validated || []).length, 0);
}

section('keys remove: indices that are not indices');
{
  for (const junk of ['-1', 'abc', '1e1', ' 0', '0.0', '99']) {
    await seed(['x', 'y']);
    const e = await threw(() => KC.keysRemove([junk], { provider: 'brave' }));
    ok(`remove(${JSON.stringify(junk)}) refuses instead of deleting something`, e !== null, e && e.message);
    eq(`remove(${JSON.stringify(junk)}) leaves the pool intact`, (await S.loadState()).brave.keys.length, 2);
  }
  await seed(['x']);
  ok('remove with no argument is a usage error',
    (await threw(() => KC.keysRemove([], { provider: 'brave' }))) !== null);
  await seed([]);
  ok('remove from an empty pool refuses',
    (await threw(() => KC.keysRemove(['0'], { provider: 'brave' }))) !== null);

  // Removing BY VALUE works — unless the value looks like a number.
  await seed(['alpha', 'beta']);
  await KC.keysRemove(['alpha'], { provider: 'brave' });
  eq('a key can be removed by its value', (await S.loadState()).brave.keys.join(), 'beta');

  await seed(['alpha', '2', 'gamma']);
  const r = await KC.keysRemove(['2'], { provider: 'brave' });
  const left = (await S.loadState()).brave.keys;
  bug('K1', 'a key whose value is all digits deletes a DIFFERENT key — the value is parsed as an index',
    r.index === 2 && left.join() === 'alpha,2',
    'src/lib/keys-cmd.mjs:95-99 — /^\\d+$/ wins before keys.indexOf(), with no way to force a by-value match');
}

section('keys remove: `current` is the one index that is not re-indexed');
{
  await seed(['A', 'B', 'C'], { current: 1 });
  await KC.keysRemove(['0'], { provider: 'brave' });
  const st = await S.loadState();
  bug('K2', 'removing a key below `current` silently repoints current at a different key',
    st.brave.current === 1 && st.brave.keys[1] === 'C',
    'src/lib/keys-cmd.mjs:103 only clamps current when it runs off the end; :107-111 re-index burned/cooldowns/validated but not current');
  ok('the shift is cosmetic today — dispatch still rotates through every key',
    st.brave.keys.length === 2);

  await seed(['A', 'B'], { current: 1 });
  await KC.keysRemove(['1'], { provider: 'brave' });
  eq('removing the current key does clamp it back into range', (await S.loadState()).brave.current, 0);
}

section('keys reset and keys clear');
{
  await seed(['A', 'B']);
  {
    const st = await S.loadState();
    S.markBurned(st, 'brave', 0, '401');
    S.setValidation(st, 'brave', 1, { ok: false, reason: 'transient network blip' });
    S.setCooldown(st, 'brave', 1, Date.now() + 60_000);
    await S.saveStateAtomic(st);
  }
  await KC.keysReset([], { provider: 'brave' });
  const r = await S.loadState();
  eq('reset clears burns', r.brave.burned.length, 0);
  eq('reset clears cooldowns', r.brave.cooldowns.length, 0);
  eq('reset drops FAILED verdicts — the whole point of running it', (r.brave.validated || []).length, 0);
  eq('and the keys are untouched', r.brave.keys.length, 2);

  {
    const st = await S.loadState();
    S.setValidation(st, 'brave', 0, { ok: true });
    S.markBurned(st, 'brave', 1, '401');
    await S.saveStateAtomic(st);
  }
  await KC.keysReset([], {});
  const all = await S.loadState();
  eq('reset with no provider clears every provider', all.brave.burned.length, 0);
  eq('but keeps a GOOD verdict, so the next run stays offline', (all.brave.validated || []).length, 1);

  await seed(['A']);
  {
    const st = await S.loadState();
    st.openrouter.keys = ['OR-KEY'];
    st.last_ok_provider = 'brave';
    await S.saveStateAtomic(st);
  }
  const noYes = await threw(() => KC.keysClear([], { provider: 'brave' }));
  ok('clear refuses non-interactively without --yes', noYes !== null && noYes.code === 'NEEDS_YES');
  await KC.keysClear([], { provider: 'brave', yes: true });
  const cleared = await S.loadState();
  eq('clearing brave empties brave', cleared.brave.keys.length, 0);
  eq('and leaves openrouter alone', cleared.openrouter.keys.length, 1);
  eq('and forgets last_ok_provider', cleared.last_ok_provider, null);
  ok('the cleared section has every field normalizeProvider expects',
    Array.isArray(cleared.brave.cooldowns) && Array.isArray(cleared.brave.validated));
  await KC.keysClear([], { all: true, yes: true });
  eq('--all clears every provider', (await S.loadState()).openrouter.keys.length, 0);
}

section('keys: Q4 — where a raw key can still reach stdout');
{
  const SECRET = 'BSA-PLAINTEXT-SECRET-XYZ-0001';
  await seed([]);
  const add = await KC.keysAdd([SECRET], SKIP);

  // `keys list --json` is masked. That fix landed. The rest did not.
  const listed = await KC.keysList([], { json: true });
  ok('keys list --json masks the key', !JSON.stringify(listed.state).includes(SECRET));
  ok('keys list (human) masks the key', !(await KC.keysList([], {})).text.includes(SECRET));

  bug('K3', 'keysAdd() hands the raw key back to the caller in `results[].key` AND in `state`',
    JSON.stringify(add.results).includes(SECRET) && JSON.stringify(add.state).includes(SECRET),
    'src/lib/keys-cmd.mjs:76 and :85 return the unmasked key and the unmasked full state');
  const SURVIVOR = 'BSA-SURVIVING-SECRET-0002';
  await KC.keysAdd([SURVIVOR], SKIP);
  const rm = await KC.keysRemove([SECRET], { provider: 'brave' });
  bug('K4', 'keysRemove() returns every SURVIVING key unmasked in its `state`',
    JSON.stringify(rm.state).includes(SURVIVOR),
    'src/lib/keys-cmd.mjs:113 — the deleted key is gone, but the rest of the pool comes back in the clear');

  // End to end through the real CLI, which is where it actually leaks.
  const cli = (args) => spawnSync(process.execPath, [KEYS_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME, SURF_QUIET: '1' },
  });
  await seed([]);
  const addOut = cli(['keys', 'add', '--provider', 'brave', SECRET, '--skip-validate', '--json']);
  bug('K5', 'Q4 ANSWERED YES: `keys add --json` prints every key in plain text on stdout',
    addOut.stdout.includes(SECRET),
    'bin/surf-research-skill.mjs:591-593 — the masking at keys-cmd.mjs:125 is only wired into `list`');

  cli(['keys', 'add', '--provider', 'brave', 'BSA-SECOND-SECRET-ABC', '--skip-validate']);
  const rmOut = cli(['keys', 'remove', '--provider', 'brave', '0', '--json']);
  bug('K6', '`keys remove --json` dumps every surviving key in plain text too',
    rmOut.stdout.includes('BSA-SECOND-SECRET-ABC'),
    'bin/surf-research-skill.mjs:591-593 — the same unmasked `result` for remove/reset/clear');

  const resetOut = cli(['keys', 'reset', '--provider', 'brave', '--json']);
  bug('K7', '`keys reset --json` leaks the pool as well',
    resetOut.stdout.includes('BSA-SECOND-SECRET-ABC'),
    'bin/surf-research-skill.mjs:591-593');

  const listOut = cli(['keys', 'list', '--json']);
  ok('but `keys list --json` really is masked end to end',
    !listOut.stdout.includes('BSA-SECOND-SECRET-ABC') && listOut.stdout.includes('…'));
  const clearOut = cli(['keys', 'clear', '--all', '--yes', '--json']);
  ok('`keys clear --all --json` has nothing left to leak', !clearOut.stdout.includes('BSA-SECOND'));
}

section('keys: maskState only masks the keys array');
{
  // maskState spreads the provider section and overwrites `keys`. Every other
  // field is passed through verbatim — including `validated[].reason`, which is
  // provider-supplied text (Brave's error.detail) and is not guaranteed to be
  // free of the token it is complaining about.
  await seed(['REALKEY-0001']);
  const st = await S.loadState();
  S.setValidation(st, 'brave', 0, { ok: false, reason: 'token REALKEY-0001 rejected by upstream' });
  await S.saveStateAtomic(st);
  const out = await KC.keysList([], { json: true });
  bug('K8', 'maskState() only masks keys[]; anything a provider wrote into validated[].reason is printed verbatim',
    JSON.stringify(out.state).includes('REALKEY-0001'),
    'src/lib/keys-cmd.mjs:129-133 — `...pp` copies burned/cooldowns/validated through unfiltered');
  ok('the keys array itself is still masked', out.state.brave.keys[0].includes('…'));
  eq('key_count is still reported for check-surf-skill.mjs', out.state.brave.key_count, 1);
  ok('--unsafe-show-keys is the documented opt-in',
    JSON.stringify((await KC.keysList([], { json: true, 'unsafe-show-keys': true })).state).includes('REALKEY-0001'));

  await seed([]);
  const empty = await KC.keysList([], {});
  ok('an empty pool still renders the how-to-fix text', empty.text.includes('keys add'));
  ok('and the no-key-no-search contract', empty.text.includes('no key, no search'));
}

// ========================================================== DISPATCH ===

section('dispatch: rotation burns the bad key and finishes on the good one');
{
  const st = await S.loadState();
  st.brave = prov({ keys: ['ROT-KEY-0', 'ROT-KEY-1'], current: 0 });
  S.setValidation(st, 'brave', 0, { ok: true });
  st._inMemory = true;
  const used = [];
  fetchPlan = async (url, init) => {
    used.push((init.headers || {})['X-Subscription-Token']);
    return reply(used.length === 1 ? BRAVE_BAD_KEY : BRAVE_RESULTS);
  };
  const res = await dispatch('search', { query: 'rotation' }, { 'no-cache': true }, { state: st });
  eq('the second key is tried after the first dies', used.join(), 'ROT-KEY-0,ROT-KEY-1');
  eq('the search still succeeds', res.data.results.length, 1);
  eq('key 0 is burned', st.brave.burned.map(b => b.index).join(), '0');
  eq('and its cached verdict was dropped with it', (st.brave.validated || []).length, 0);
  eq('current is moved to the key that worked', st.brave.current, 1);
  ok('an in-memory state is never written to disk', (await S.loadState()).brave.keys.length === 0);
}

section('dispatch: `current` is persisted for the next process');
{
  await seed(['PERSIST-0', 'PERSIST-1']);
  const st = await S.loadState();
  S.setValidation(st, 'brave', 0, { ok: true });
  await S.saveStateAtomic(st);
  const live = await S.loadState();
  let n = 0;
  fetchPlan = async () => reply(++n === 1 ? BRAVE_BAD_KEY : BRAVE_RESULTS);
  await dispatch('search', { query: 'persist me' }, { 'no-cache': true }, { state: live });
  const disk = await S.loadState();
  eq('the burn reaches keys.json', disk.brave.burned.map(b => b.index).join(), '0');
  eq('and so does the new current', disk.brave.current, 1);
}

section('dispatch: the errors that must NOT burn a key');
for (const [label, spec, kind] of [
  ['a plan gate (OPTION_NOT_IN_PLAN)', { status: 400, body: { error: { code: 'OPTION_NOT_IN_PLAN' } } }, 'plan_gate'],
  ['a bad parameter (422 VALIDATION)', { status: 422, body: { error: { code: 'VALIDATION', meta: { errors: [{ loc: ['query', 'count'] }] } } } }, 'config_4xx'],
  ['an unattributable 4xx', { status: 422, body: {} }, 'config_4xx'],
]) {
  const st = await S.loadState();
  st.brave = prov({ keys: ['KEEP-ME-0', 'KEEP-ME-1'] });
  S.setValidation(st, 'brave', 0, { ok: true });
  st._inMemory = true;
  let calls = 0;
  fetchPlan = async () => { calls++; return reply(spec); };
  const e = await threw(() => dispatch('search', { query: 'x' }, { 'no-cache': true }, { state: st }));
  ok(`${label} throws to the caller`, e !== null, e && e.message);
  eq(`${label} is classified as ${kind}`, e && e.kind, kind);
  eq(`${label} burns nothing`, st.brave.burned.length, 0);
  eq(`${label} cools nothing down`, st.brave.cooldowns.length, 0);
  eq(`${label} does not retry, and does not rotate to the second key`, calls, 1);
}

section('dispatch: a 429 sidelines the key instead of burning it');
{
  const st = await S.loadState();
  st.brave = prov({ keys: ['THROTTLED-0', 'FRESH-1'] });
  S.setValidation(st, 'brave', 0, { ok: true });
  st._inMemory = true;
  const used = [];
  fetchPlan = async (url, init) => {
    used.push((init.headers || {})['X-Subscription-Token']);
    return reply(used.length <= 3 ? { status: 429, body: { error: { code: 'RATE_LIMITED' } } } : BRAVE_RESULTS);
  };
  const res = await dispatch('search', { query: 'throttle' }, { 'no-cache': true }, { state: st });
  eq('the throttled key is retried, then handed over to the next one', used[used.length - 1], 'FRESH-1');
  eq('and the search still returns', res.data.results.length, 1);
  eq('a 429 never burns', st.brave.burned.length, 0);
  eq('it sets a cooldown instead', st.brave.cooldowns.map(c => c.index).join(), '0');
  ok('the cooldown is in the future', S.cooldownActive(st.brave, 0));
}

section('dispatch: the gate still fires before any request');
{
  offline();
  const st = await S.loadState();
  st.brave = prov({ keys: ['proven-bad'] });
  S.setValidation(st, 'brave', 0, { ok: false, reason: 'SUBSCRIPTION_TOKEN_INVALID' });
  st._inMemory = true;
  const before = fetchCalls;
  const e = await threw(() => dispatch('search', { query: 'x' }, { 'no-cache': true }, { state: st }));
  ok('a pool of proven-bad keys never reaches the network', e !== null && fetchCalls === before);
  eq('and it is the gate that says so', e && e.name, 'GateError');
  eq('with exit 78', e && e.exitCode, 78);

  const emptyState = await S.loadState();
  emptyState.brave = S.blankProvider();
  emptyState._inMemory = true;
  const noKeys = await threw(() => dispatch('search', { query: 'x' }, { 'no-cache': true }, { state: emptyState }));
  ok('an empty pool fails before the network too', noKeys !== null);
  eq('and it is reported as NoProviderAvailable, before the gate', noKeys && noKeys.code, 'NoProviderAvailable');
}

// ------------------------------------------------------------- summary ---

await seed([]);
process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${bugs.length} bug(s) proven, ${fixed.length} fixed\n`);
if (bugs.length) {
  process.stdout.write(`\nDEFECTS PROVEN BY THIS SUITE (informational — they do not fail the run):\n`);
  for (const b of bugs) process.stdout.write(`  ⚠ ${b}\n`);
}
if (fixed.length) {
  process.stdout.write(`\nPREVIOUSLY PROVEN DEFECTS THAT NO LONGER REPRODUCE:\n`);
  for (const f of fixed) process.stdout.write(`  ✓ ${f}\n`);
}
if (failures.length) {
  process.stdout.write(`\nASSERTIONS THAT MUST HOLD AND DID NOT:\n`);
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('gate-state-ok\n');
