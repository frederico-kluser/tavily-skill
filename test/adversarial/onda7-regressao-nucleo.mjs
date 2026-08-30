#!/usr/bin/env node
// ONDA-7 REGRESSION suite — the four nucleus fixes, tested in the INTEGRATED
// state (everything merged on main):
//
//   F1  state    (commit 4b1932e)  TTL unilateral no veredito de validacao;
//                                  burn sem `at` sobrevive ao load
//   F7  dispatch (commit 9da0951)  cota mensal 429 pula a chave (nao dorme);
//                                  o anel comeca na chave que o portao abencoa
//   F8  env      (commit 47df1e6)  burn segue so chaves do keys.json; opts nao
//                                  herda burn; .env re-lido por stat; plural
//                                  CSV; warn de case
//   F10 preflight(commit 591bb20)  PRESENT_UNPROVEN; 6 codigos BraveKey*;
//                                  UMA definicao de provesKeyBad
//
// This suite is ADDITIVE: it touches no other test file. Every assertion here
// pins CORRECTED behaviour, so in the integrated state everything must pass —
// a failure is either a broken test or a real regression (reported, never
// weakened). The bug() records below are the historical defects, asserted as
// "no longer reproduces", the same conversion the audit applied to BUG-21b /
// D1b / P1b: a bug() condition is TRUE while the defect is back.
//
// ZERO NETWORK: HOME must be a throwaway dir (the H10 trap — config constants
// freeze at module import, so this file mutates env BEFORE any src import and
// then seals the sandbox). globalThis.fetch is replaced with a scripted stub
// before the first call; the outer run may additionally install
// preload-zero-rede.cjs via NODE_OPTIONS to count sockets/dns and kill the
// real fetch. SURF_NO_RATE_LIMIT=1 keeps pacing and the ratelimit ledger off.
//
// Run:   NODE_OPTIONS="--require /tmp/surf-audit-20260830/test-nucleo/preload-zero-rede.cjs" \
//        HOME=$(mktemp -d) node test/adversarial/onda7-regressao-nucleo.mjs

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ------------------------------------------------------- env hygiene (H10) ---
// Config constants (CONFIG_DIR, CACHE_DIR, ratelimit DISABLED, progress silent,
// cooldown ms) freeze at MODULE LOAD. Run this BEFORE the first import of any
// src module — which is why every src import below is dynamic.
for (const v of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) {
  delete process.env[v];
}
process.env.SURF_NO_RATE_LIMIT = '1';               // ratelimit: instant slots, ledger off
process.env.SURF_NO_TIMEOUT = '1';                  // dispatch: no harness-budget watchdog
process.env.SURF_QUIET = '1';                       // progress: silent unless patched (F8 warn capture)
process.env.SURF_RATE_LIMIT_COOLDOWN_MS = '60000';  // deterministic 1-minute cooldown

const HOME = homedir();
if (!String(HOME).startsWith(tmpdir())) {
  process.stderr.write(`REFUSING TO RUN — HOME=${HOME} is not under ${tmpdir()} (H10 sandbox seal)\n`);
  process.exit(1);
}

// ------------------------------------------------------------- reporting ---
const out = (s) => process.stdout.write(s);
let passed = 0;
const failures = [];
const bugs = [];
const fixed = [];
function ok(name, cond, detail) {
  if (cond) { passed++; out(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); out(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/**
 * A historical defect, asserted as "no longer reproduces". NEVER touches the
 * exit code (same convention as brave-limits.mjs): the ok()/eq() pins carry
 * the gate. `stillBroken` TRUE means the fix regressed — reported with
 * evidence in the summary.
 */
function bug(id, title, stillBroken, evidence) {
  if (stillBroken) {
    bugs.push(`${id}  ${title}${evidence ? '\n        ' + evidence : ''}`);
    out(`  ⚠ BUG ${id} RETURNED: ${title}\n${evidence ? '      ' + evidence + '\n' : ''}`);
  } else {
    fixed.push(id);
    out(`  ✓ ${id} no longer reproduces — ${title}\n`);
  }
}
function section(t) { out(`\n${t}\n`); }
async function attempt(fn) {
  try { return { value: await fn() }; } catch (e) { return { err: e }; }
}

const LIB = (m) => new URL(`../../src/lib/${m}`, import.meta.url).href;

// ------------------------------------------------------------ imports ---
// All dynamic, all AFTER the env block.
const S = await import(LIB('state.mjs'));
const PF = await import(LIB('preflight.mjs'));
const ENV = await import(new URL('../../src/env.mjs', import.meta.url).href);
const { dispatch } = await import(LIB('dispatch.mjs'));
const cache = await import(LIB('cache.mjs'));
const { progress } = await import(LIB('progress.mjs'));
const { GATE, EXIT_CONFIG } = PF;

// Capture warn/retry so the suite can assert WHAT was announced (F7 quota
// skip, F8 case warning) and WHAT was not (no retry for a monthly 429).
const captured = { warn: [], retry: [] };
progress.warn = (m) => captured.warn.push(String(m));
progress.retry = (m) => captured.retry.push(String(m));

// -------------------------------------------------------- fetch harness ---
// Zero network: the suite's stub replaces the preload's thrower the moment it
// runs; every call must have a fetchPlan or it dies.
let fetchPlan = null;
let fetchCalls = 0;      // per-test, reset by resetFetch()
let scriptedCalls = 0;   // lifetime total of stub calls (fake, never reset)
let tokens = [];
globalThis.fetch = async (url, init = {}) => {
  fetchCalls++;
  scriptedCalls++;
  tokens.push((init.headers || {})['X-Subscription-Token'] || '?');
  if (!fetchPlan) throw Object.assign(new Error('onda7: no fetchPlan — the real network must not be touched'), { kind: 'network' });
  return fetchPlan(url, init);
};
function reply({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: async () => JSON.stringify(body),
  };
}
const OK_RESULTS = { status: 200, body: { web: { results: [{ title: 't', url: 'https://example.com/r', description: 'd' }] }, query: {} } };
function sequence(specs) {
  const q = [...specs];
  let last = specs[specs.length - 1];
  fetchPlan = async () => reply(q.length ? (last = q.shift()) : last);
}
function always(spec) { fetchPlan = async () => reply(spec); }
function resetFetch() { fetchPlan = null; fetchCalls = 0; tokens = []; }

const prov = (over = {}) => ({ ...S.blankProvider(), ...over });
const mem = (brave) => ({ brave, openrouter: S.blankProvider(), _inMemory: true });
const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
/** Write a hand-shaped keys.json in the FAKE home and let loadState normalize it. */
async function seedRaw(braveSection) {
  await mkdir(path.dirname(S.KEYS_FILE), { recursive: true });
  await writeFile(S.KEYS_FILE, JSON.stringify({
    schema_version: 1, last_ok_provider: null,
    brave: braveSection, openrouter: S.blankProvider(),
  }, null, 2));
}

// ======================================================== F1: state ===
section('F1 state: the validation TTL is unilateral; a burn without a date survives');
{
  const TTL = S.VALIDATION_TTL_MS;
  const make = (atIso) => { const st = mem(prov({ keys: ['k'] })); S.setValidation(st, 'brave', 0, { ok: true }); st.brave.validated[0].at = atIso; return st; };

  // P1/S2: a stamp beyond one TTL AHEAD cannot describe a verdict this key
  // earned — a thumbnail clock step (or hand edit) must not make the gate
  // trust a revoked key forever.
  const farFuture = nowIso(10 * 365 * 24 * 3600 * 1000);
  eq('a verdict stamped 10 years ahead expires immediately (getValidation → null)',
    S.getValidation(make(farFuture), 'brave', 0), null);
  bug('F1r', 'state: a far-future validation verdict never expires — the gate trusts a revoked key forever (P1 returned)',
    S.getValidation(make(nowIso(10 * 365 * 24 * 3600 * 1000)), 'brave', 0) !== null,
    'src/lib/state.mjs validationAge() — a stamp beyond one TTL ahead must be stale');

  // Round-trip: normalizeProvider prunes the same boundary, so the poison
  // never survives a save (P1b read as FIXED).
  await seedRaw(prov({ keys: ['k'], validated: [{ index: 0, at: farFuture, ok: true }] }));
  ok('the round-trip through keys.json prunes the far-future verdict',
    (await S.loadState()).brave.validated.length === 0);

  // A stamp ahead but WITHIN one TTL is a clock that moved (NTP, laptop resume)
  // — clamped to age 0, still a hit. The clamp is part of the fix contract.
  ok('a stamp ahead within one TTL is clamped to age 0 and still hits',
    S.getValidation(make(nowIso(TTL / 2)), 'brave', 0) !== null);

  // EXACT TTL: getValidation (`>=`) and normalizeProvider (`<`) must agree to
  // the millisecond — one boundary, shared (the fix's stated point).
  const atExact = new Date(Date.now() - TTL).toISOString();
  eq('at exactly TTL the verdict is already dead in memory (getValidation → null)',
    S.getValidation(make(atExact), 'brave', 0), null);
  await seedRaw(prov({ keys: ['k'], validated: [{ index: 0, at: atExact, ok: true }] }));
  ok('normalizeProvider prunes the same entry on load — the two boundaries agree',
    (await S.loadState()).brave.validated.length === 0);

  // Pins just inside / just outside the TTL.
  ok('TTL−1s is a hit (getValidation returns the entry)',
    S.getValidation(make(nowIso(-(TTL - 1000))), 'brave', 0) !== null);
  await seedRaw(prov({ keys: ['k'], validated: [{ index: 0, at: nowIso(-(TTL - 1000)), ok: true }] }));
  ok('TTL−1s survives the round-trip (kept by normalizeProvider)',
    (await S.loadState()).brave.validated.length === 1);
  eq('TTL+1s is a miss (getValidation → null)',
    S.getValidation(make(nowIso(-(TTL + 1000))), 'brave', 0), null);
  await seedRaw(prov({ keys: ['k'], validated: [{ index: 0, at: nowIso(-(TTL + 1000)), ok: true }] }));
  ok('TTL+1s is pruned by the round-trip',
    (await S.loadState()).brave.validated.length === 0);

  // S5: a burn with NO month to compare is NOT a reset signal. Dropping it
  // would silently un-burn a key the system proved dead.
  await seedRaw(prov({ keys: ['k'], burned: [{ index: 0, reason: '401' }] }));
  ok('a burn without `at` survives loadState (no month to compare → not a reset)',
    (await S.loadState()).brave.burned.length === 1);
  await seedRaw(prov({ keys: ['k'], burned: [{ index: 0, at: 'not-a-date', reason: '401' }] }));
  ok('a burn with an unparseable `at` survives loadState too',
    (await S.loadState()).brave.burned.length === 1);
  await seedRaw(prov({ keys: ['k'], burned: [{ index: 0, at: '2000-01-01T00:00:00.000Z', reason: '401' }] }));
  eq('control: a burn dated in a previous month still auto-clears (monthly reset intact)',
    (await S.loadState()).brave.burned.length, 0);
}

// ==================================================== F7: dispatch ===
section('F7 dispatch: monthly quota is not a backoff; the ring follows the gate; cache without a key');
{
  // THE MONTHLY QUOTA IS NOT A BACKOFF. SUBSCRIPTION_QUOTA_EXCEEDED must skip
  // the key with NO sleep — the month will not refill for anything this
  // process can wait for — and the next key answers.
  const st = mem(prov({ keys: ['QUOTA-EMPTY', 'STILL-FULL'] }));
  S.setValidation(st, 'brave', 0, { ok: true });
  S.setValidation(st, 'brave', 1, { ok: true });
  captured.retry.length = 0; captured.warn.length = 0;
  resetFetch();
  sequence([
    { status: 429, body: { error: { code: 'SUBSCRIPTION_QUOTA_EXCEEDED', detail: 'monthly quota eaten' } } },
    OK_RESULTS,
  ]);
  const t0 = Date.now();
  const r = await attempt(() => dispatch('search', { query: 'quota rotation question' }, { 'no-cache': true }, { state: st }));
  const elapsed = Date.now() - t0;
  eq('the exhausted key is skipped and the second key answers',
    tokens.join(','), 'QUOTA-EMPTY,STILL-FULL');
  ok('success rides on the second key',
    !!r.value && r.value.data.results.length === 1, r.err ? `${r.err.code}: ${r.err.message}` : 'ok');
  ok('the monthly 429 slept NOTHING (elapsed < 400ms)', elapsed < 400, `${elapsed}ms`);
  eq('... and no backoff message was logged', captured.retry.length, 0);
  ok('the monthly fact is announced as a skip, not a retry',
    captured.warn.some(m => m.includes('monthly quota exhausted')), JSON.stringify(captured.warn));
  ok('the exhausted key is cooldowned so the next run skips it too',
    S.cooldownActive(st.brave, 0));
  bug('F7r', 'dispatch: a monthly-quota 429 was slept as a short backoff — time stolen from the key that still has quota',
    captured.retry.length > 0 || elapsed >= 1000,
    `retries=${captured.retry.length}, elapsed=${elapsed}ms — dispatch.mjs must setCooldown and move on`);

  // A plain per-window 429 IS a backoff: wait, retry (twice), and only THEN
  // sideline the key.
  const st2 = mem(prov({ keys: ['RATE-WINDOW', 'AFTER'] }));
  S.setValidation(st2, 'brave', 0, { ok: true });
  S.setValidation(st2, 'brave', 1, { ok: true });
  captured.retry.length = 0; captured.warn.length = 0;
  resetFetch();
  sequence([
    { status: 429, body: { error: { code: 'RATE_LIMITED' } }, headers: { 'x-ratelimit-reset': '0, 1000' } },
    { status: 429, body: { error: { code: 'RATE_LIMITED' } }, headers: { 'x-ratelimit-reset': '0, 1000' } },
    { status: 429, body: { error: { code: 'RATE_LIMITED' } }, headers: { 'x-ratelimit-reset': '0, 1000' } },
    OK_RESULTS,
  ]);
  const t1 = Date.now();
  const r2 = await attempt(() => dispatch('search', { query: 'rate window question' }, { 'no-cache': true }, { state: st2 }));
  const elapsed2 = Date.now() - t1;
  eq('the window-429 key is retried twice, then the ring moves on',
    tokens.join(','), 'RATE-WINDOW,RATE-WINDOW,RATE-WINDOW,AFTER');
  ok('the retries were real short backoffs (2× ~250ms sleeps, ≥450ms total)',
    captured.retry.length === 2 && elapsed2 >= 450, `retries=${captured.retry.length}, elapsed=${elapsed2}ms`);
  ok('the cooldown lands only AFTER the retries are exhausted',
    !!r2.value && S.cooldownActive(st2.brave, 0));
  ok('and the monthly-quota warning is NOT emitted for a window 429',
    !captured.warn.some(m => m.includes('monthly quota')), JSON.stringify(captured.warn));

  // D1: the gate blesses #1; the ring's would-be first pick (#0) has NO
  // verdict at all, so the first request must ride the blessed key.
  const st3 = mem(prov({ keys: ['NEVER-CHECKED', 'PROVEN-GOOD'], current: 0 }));
  S.setValidation(st3, 'brave', 1, { ok: true });
  const g = PF.gateStatus(st3, 'brave');
  resetFetch();
  always(OK_RESULTS);
  eq('the gate blesses key #1 while #0 is unjudged', g.index, 1);
  const r3 = await attempt(() => dispatch('search', { query: 'gate blessed ring question' }, { 'no-cache': true }, { state: st3 }));
  ok('the first request rides the gate-blessed key (D1 fix)',
    !r3.err && tokens[0] === 'PROVEN-GOOD', `tokens=${tokens.join(',')} err=${r3.err && r3.err.code}`);
  eq('and it cost exactly one request — nothing burned, nothing retried', fetchCalls, 1);
  eq('the unjudged key is not burned by the fix', st3.brave.burned.length, 0);
  bug('F7d', 'dispatch: the gate blessed #1 but the ring spent the first request on unjudged #0 (D1 returned)',
    tokens[0] === 'NEVER-CHECKED', `first token=${tokens[0]} — the ring must start at the gate index`);

  // The D1 override is deliberately NARROW: with every key carrying a verdict,
  // the ring keeps its own first pick — no pinning everyone to the gate.
  const st4 = mem(prov({ keys: ['VERDICTED-0', 'VERDICTED-1'], current: 0 }));
  S.setValidation(st4, 'brave', 0, { ok: false, reason: 'stale verdict' });  // a verdict exists…
  S.setValidation(st4, 'brave', 1, { ok: true });                           // …and the gate trusts #1
  const g4 = PF.gateStatus(st4, 'brave');
  resetFetch();
  sequence([
    { status: 422, body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'no' } } },
    OK_RESULTS,
  ]);
  eq('with all keys verified, the gate trusts #1 while #0 carries a bad verdict', g4.index, 1);
  const r4 = await attempt(() => dispatch('search', { query: 'ring keeps its own order' }, { 'no-cache': true }, { state: st4 }));
  eq('the ring still tries its own first pick #0 (override only for UNJUDGED candidates)',
    tokens.join(','), 'VERDICTED-0,VERDICTED-1');
  ok('#0 burns honestly on auth and #1 answers — plain multi-key rotation is intact',
    !!r4.value && r4.value.data.results.length === 1 && st4.brave.burned.some(b => b.index === 0),
    JSON.stringify({ tokens, burned: st4.brave.burned }));

  // Deliberate, documented hole (BUG-42 in brave-limits.mjs): a cache hit is
  // served with NO key at all. It must NOT regress — a hit costs no credit
  // and no network, and refusing it would be a regression, not a safety win.
  resetFetch();
  const cachedArgs = { query: 'a question answered six hours ago' };
  mkdirSync(S.CACHE_DIR, { recursive: true });
  const cKey = cache.cacheKey('brave', 'search', cachedArgs);
  await cache.cacheSet(cKey, {
    provider: 'brave', usage: { credits: 0 }, latency_ms: 1,
    data: { query: cachedArgs.query, results: [{ url: 'https://cached.example' }] },
  });
  const noKey = mem(S.blankProvider());
  const hit = await attempt(() => dispatch('search', cachedArgs, {}, { state: noKey }));
  ok('a cache hit with NO key configured is still served (deliberate — must not regress)',
    !hit.err && hit.value && hit.value.data.results[0].url === 'https://cached.example',
    hit.err ? `${hit.err.code}: ${hit.err.message}` : JSON.stringify(hit.value && hit.value.data.results));
  eq('and it cost zero network calls', fetchCalls, 0);
}

// ======================================================== F8: env ===
section('F8 env: provenance-aware burn, opts stay clean, .env re-read by stat, plural CSV, case warning');
{
  // A hand-edited keys.json with the SAME dead value twice: the burn must
  // follow the surviving value (a value→index Map would keep only the last
  // occurrence and drop the burn).
  await seedRaw(prov({
    keys: ['dead-dead', 'dead-dead'],
    burned: [{ index: 0, at: nowIso(), reason: 'auth' }],
    validated: [{ index: 0, at: nowIso(), ok: true }],
  }));
  const dup = await ENV.buildInMemoryState({ skipDotenv: true });
  ok('a duplicated dead key in keys.json stays burned in the merged state',
    dup.brave.burned.length === 1 && dup.brave.burned[0].index === 0 && dup.brave.burned[0].reason === 'auth',
    JSON.stringify(dup.brave.burned));
  eq('the deduped in-memory key list still carries the one key', dup.brave.keys.join(','), 'dead-dead');
  ok('and its cached verdict follows by value too', dup.brave.validated.length === 1);

  // The SAME value via opts: burn is the CLI store's proof, so a caller that
  // explicitly asks for the key fresh starts clean — while cooldowns and
  // verdicts still match by value (provenance-gated burn, value-gated rest).
  const viaOpts = await ENV.buildInMemoryState({ skipDotenv: true, braveKey: 'dead-dead' });
  eq('a key passed through opts does NOT inherit the store burn', viaOpts.brave.burned.length, 0);
  eq('... but its preserved verdict still follows by value', viaOpts.brave.validated.length, 1);

  // .env rewritten under a long-lived process: the stat-gated cache must
  // re-read it (mtime:size key), or a key rotation in the file never lands.
  const dirE = mkdtempSync(path.join(tmpdir(), 'onda7-env-'));
  await writeFile(path.join(dirE, '.env'), 'BRAVE_API_KEY=first-key\n');
  const e1 = await ENV.discoverKeys({ cwd: dirE, skipConfigFile: true });
  await writeFile(path.join(dirE, '.env'), 'BRAVE_API_KEY=second-key-much-longer\n');
  const e2 = await ENV.discoverKeys({ cwd: dirE, skipConfigFile: true });
  eq('the .env is read on the first call', e1.brave.join(','), 'first-key');
  eq('a rewritten .env is re-read by the same long-lived process (stat-gated cache)',
    e2.brave.join(','), 'second-key-much-longer');

  // opts.braveKeys is the CSV mirror of BRAVE_API_KEYS: the plural splits.
  const dirP = mkdtempSync(path.join(tmpdir(), 'onda7-opts-'));
  const plural = await ENV.discoverKeys({ cwd: dirP, skipDotenv: true, skipConfigFile: true, braveKeys: 'k1,k2' });
  eq('opts.braveKeys "k1,k2" (plural) means TWO keys', plural.brave.join(','), 'k1,k2');
  const trimmed = await ENV.discoverKeys({ cwd: dirP, skipDotenv: true, skipConfigFile: true, braveKeys: ' k1 , k2 ' });
  eq('CSV entries are trimmed like the env level does', trimmed.brave.join(','), 'k1,k2');

  // A lowercase spelling is a DIFFERENT variable (shell semantics) — ignored
  // by discovery, but announced, never silent.
  const dirL = mkdtempSync(path.join(tmpdir(), 'onda7-low-'));
  await writeFile(path.join(dirL, '.env'), 'brave_api_key=lowercase-secret\n');
  captured.warn.length = 0;
  const low = await ENV.discoverKeys({ cwd: dirL, skipConfigFile: true });
  eq('a lowercase brave_api_key is NOT read (case-sensitive discovery)', low.brave.length, 0);
  ok('and it is announced with a case warning instead of silence',
    captured.warn.some(m => m.includes('brave_api_key') && m.includes('BRAVE_API_KEY')),
    JSON.stringify(captured.warn));
}

// ==================================================== F10: preflight ===
section('F10 preflight: PRESENT_UNPROVEN, six BraveKey codes, one provesKeyBad');
{
  const st = mem(prov({ keys: ['never-validated-key'] }));
  const off = await PF.resolveGate(st, 'brave', { allowLive: false, persist: false });
  eq('allowLive:false + never-validated ⇒ PRESENT_UNPROVEN, never READY',
    off.verdict, GATE.PRESENT_UNPROVEN);
  const e = await attempt(() => PF.assertProviderReady(st, 'brave', { allowLive: false, persist: false }));
  ok('assertProviderReady refuses it (GateError)', e.err instanceof PF.GateError, `${e.err && e.err.constructor.name}: ${e.err && e.err.message && e.err.message.slice(0, 80)}`);
  eq('with the BraveKeyUnproven code', e.err && e.err.code, 'BraveKeyUnproven');
  eq('and exit 78', e.err && e.err.exitCode, EXIT_CONFIG);
  eq('EX_CONFIG stays 78, distinct from 1 and 2', EXIT_CONFIG, 78);
  ok('the fix says to re-run online — never to remove the key',
    /without the offline flag/i.test(e.err.message) && !/keys remove/.test(e.err.message),
    'the offline probe is free; the key was never judged');
  const proven = mem(prov({ keys: ['already-proven'] }));
  S.setValidation(proven, 'brave', 0, { ok: true });
  eq('an already-proven key still passes an offline gate (only never-judged keys become PRESENT_UNPROVEN)',
    (await PF.resolveGate(proven, 'brave', { allowLive: false, persist: false })).verdict, GATE.READY);

  // All six verdicts in the BraveKey* family — a caller matching /^BraveKey/
  // sees PRESENT_UNPROVEN too (BraveKeyUnproven).
  const codes = [
    [GATE.MISSING, 'BraveKeyMissing'],
    [GATE.BURNED, 'BraveKeyBurned'],
    [GATE.COOLING, 'BraveKeyCooling'],
    [GATE.INVALID, 'BraveKeyInvalid'],
    [GATE.UNREACHABLE, 'BraveKeyUnverified'],
    [GATE.PRESENT_UNPROVEN, 'BraveKeyUnproven'],
  ];
  for (const [v, expect] of codes) {
    const c = PF.formatGate(v, 'detail here', 'brave').code;
    ok(`${v} → ${expect} (matches /^BraveKey/)`, c === expect && /^BraveKey/.test(c), c);
  }

  // THE definition: exactly ONE `function provesKeyBad` in src/, exported by
  // the gate and imported by keys-cmd — two copies of "is this key bad?" were
  // two ways to condemn a working key.
  const srcDir = path.resolve(path.dirname(SELF), '..', '..', 'src');
  const defs = [];
  let keysCmdSecondCopy = false;
  let keysCmdUsesImport = false;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith('.mjs')) {
        const t = await readFile(p, 'utf8');
        const n = (t.match(/function provesKeyBad\s*\(/g) || []).length;
        if (n > 0) defs.push({ file: p, n });
        if (p.endsWith('keys-cmd.mjs')) {
          keysCmdSecondCopy = keysCmdSecondCopy || n > 0;
          keysCmdUsesImport = keysCmdUsesImport
            || (/provesKeyBad as gateProvesKeyBad/.test(t) && /gateProvesKeyBad\(/.test(t));
        }
      }
    }
  };
  await walk(srcDir);
  eq('exactly ONE definition of provesKeyBad in src/', defs.length, 1);
  ok('and it lives in preflight.mjs (the gate\'s taxonomy)',
    defs.length === 1 && defs[0].file.endsWith(path.join('lib', 'preflight.mjs')), JSON.stringify(defs));
  eq('keys-cmd.mjs holds no second copy', keysCmdSecondCopy, false);
  ok('keys-cmd.mjs imports the gate\'s predicate and calls it', keysCmdUsesImport);

  // The shared predicate keeps its whitelist answer: only 'auth' convicts.
  eq('an auth proof convicts the key', PF.provesKeyBad({ valid: false, kind: 'auth' }), true);
  eq('a network failure proves nothing about the key', PF.provesKeyBad({ valid: false, kind: 'network' }), false);
  eq('a Brave 5xx proves nothing', PF.provesKeyBad({ valid: false, kind: 'server_5xx' }), false);
  eq('an unattributable 4xx proves nothing', PF.provesKeyBad({ valid: false, kind: 'caller_4xx' }), false);
  eq('a plan gate proves nothing', PF.provesKeyBad({ valid: false, kind: 'plan_gate' }), false);
  eq('a positive result is never bad', PF.provesKeyBad({ valid: true, kind: null }), false);
}

// ============================================================== summary ===
section('summary');
const netCounts = globalThis.__zeroRedeNetwork
  ? globalThis.__zeroRedeNetwork.counts()
  : { sockets: 'n/a (preload absent)', dns: 'n/a (preload absent)' };
const havePreload = Number.isFinite(netCounts.sockets);
ok('zero real sockets and zero dns lookups (preload counters; n/a = preload absent)',
  !havePreload || (netCounts.sockets === 0 && netCounts.dns === 0), JSON.stringify(netCounts));

out(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) out(`  x ${f}\n`);
out(`${bugs.length} defect(s) reproduced${fixed.length ? `, ${fixed.length} no longer reproduce (${fixed.join(', ')})` : ''}\n`);
for (const b of bugs) out(`  ${b}\n`);
out(`rede: ${havePreload ? `${netCounts.sockets} socket(s), ${netCounts.dns} dns lookup(s)` : netCounts.sockets} — fetch stub calls (scripted, fake): ${scriptedCalls}\n`);

if (failures.length) process.exit(1);
out('onda7-regressao-nucleo-ok\n');