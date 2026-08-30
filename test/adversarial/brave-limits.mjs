#!/usr/bin/env node
// ADVERSARIAL suite: the Brave adapter and the rate limiter under hostile input.
//
// This is not a coverage exercise. Every block below feeds a malformed, absurd
// or merely unlucky input to code that will one day meet exactly that input,
// and records what actually happens.
//
// TWO LEDGERS, ON PURPOSE:
//
//   ok()/eq()  — CORRECT behaviour that must not regress. A failure here is a
//                real failure and the process exits 1.
//   bug()      — a DEFECT this suite reproduces on purpose. Bugs are counted
//                separately and NEVER change the exit code, so wave 1 can prove
//                them without breaking the build. When a fix lands, bug() flips
//                to "no longer reproduces" instead of failing — which makes this
//                file the acceptance test for the fixing wave.
//
// QUOTA: zero network. globalThis.fetch is stubbed before anything is imported
// that could use it, SURF_BRAVE_API_BASE points at an unroutable host, and HOME
// is a throwaway directory. Not one Brave credit is spent by this file.
//
// Run: node test/adversarial/brave-limits.mjs
//
// BUG ids are stable labels, not an ordering: BUG-43 was found while writing the
// suite and kept its number so a fix can be tracked against it. Wall time is ~4s,
// almost all of it the two pacing subprocesses (a real 1 rps wait, and a 3s
// lock-contention measurement). The suite is NOT wired into `npm test` because
// this wave was not allowed to touch package.json; add it as
// `node ./test/adversarial/brave-limits.mjs` once the fixes land.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MODE = process.env.SURF_ADV_MODE || '';

// ---------------------------------------------------------------- harness ---
// The parent re-execs itself with HOME pointed at a throwaway directory, the
// way test/brave.mjs does. Sub-modes ('pace', 'pace-lock') are grandchildren
// spawned by the main child: the rate limiter reads SURF_NO_RATE_LIMIT and
// SURF_BRAVE_MAX_WAIT_MS ONCE, at module load, so the only way to exercise it
// under a different policy is a fresh process.

if (!process.env.SURF_ADV_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-adv-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  mkdirSync(path.join(home, '.cache', 'surf'), { recursive: true });
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_ADV_CHILD: '1',
      SURF_QUIET: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      // Off for the adapter sections; the pacing grandchildren turn it back on.
      SURF_NO_RATE_LIMIT: '1',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

const LIB = (m) => new URL(`../../src/lib/${m}`, import.meta.url).href;
const out = (s) => process.stdout.write(s);

// --------------------------------------------------------- pacing subprocess ---
// Grandchild A: the limiter with pacing ARMED (SURF_NO_RATE_LIMIT unset).
if (MODE === 'pace') {
  const { CACHE_DIR } = await import(LIB('state.mjs'));
  const rl = await import(LIB('ratelimit.mjs'));
  const L = path.join(CACHE_DIR, 'ratelimit.json');
  const id = (k) => createHash('sha256').update(k).digest('hex').slice(0, 16);
  const res = {};

  // 1. A ledger that is not JSON at all must degrade, not throw.
  writeFileSync(L, '{ this is not json');
  res.corrupt = await rl.acquireSlot('corrupt-key');

  // 2. `recent` that is not an array, and a nonsense rps.
  writeFileSync(L, JSON.stringify({
    [id('shape-key')]: { recent: { nope: 1 }, rps: -5, at: new Date().toISOString() },
  }));
  res.badShape = await rl.acquireSlot('shape-key');

  // 3. Real pacing: on a 1 rps plan the second slot must cost ~1s.
  writeFileSync(L, JSON.stringify({}));
  let t = Date.now(); await rl.acquireSlot('pace-key'); res.firstMs = Date.now() - t;
  t = Date.now(); res.second = await rl.acquireSlot('pace-key'); res.secondMs = Date.now() - t;

  // 4. Timestamps from the future (a backwards NTP step, a shared HOME on a
  //    machine with a skewed clock) never leave the 1-second window.
  writeFileSync(L, JSON.stringify({ [id('future-key')]: { recent: [Date.now() + 3_600_000] } }));
  t = Date.now(); res.future1 = await rl.acquireSlot('future-key'); res.future1Ms = Date.now() - t;
  t = Date.now(); res.future2 = await rl.acquireSlot('future-key'); res.future2Ms = Date.now() - t;
  res.futureLedgerKept = JSON.parse(readFileSync(L, 'utf8'))[id('future-key')].recent.length;

  // 5. effectiveParallelism against a duplicated key.
  writeFileSync(L, JSON.stringify({}));
  res.effDup = await rl.effectiveParallelism(['dup', 'dup']);
  res.effSingle = await rl.effectiveParallelism(['dup']);
  res.effEmpty = await rl.effectiveParallelism([]);
  res.effNull = await rl.effectiveParallelism(null);

  // 6. learnFromBody teaches the monthly counter; learnFromHeaders then meets a
  //    200 that carries a policy but no x-ratelimit-remaining.
  await rl.learnFromBody('learn-key', {
    error: { meta: { plan: 'Free', rate_limit: 1, quota_limit: 2000, quota_current: 1900 } },
  });
  res.monthlyAfterBody = await rl.monthlyRemaining('learn-key');
  res.planAfterBody = await rl.knownPlan('learn-key');
  await rl.learnFromHeaders('learn-key', new Map([['x-ratelimit-policy', '1;w=1, 2000;w=2678400']]));
  res.monthlyAfterHeaders = await rl.monthlyRemaining('learn-key');
  res.planAfterHeaders = await rl.knownPlan('learn-key');

  // 7. A 429 body with the plan and the quota but no rate_limit.
  res.learnNoRate = await rl.learnFromBody('partial-key', {
    error: { meta: { plan: 'Search', quota_limit: 2000, quota_current: 3 } },
  });
  res.planPartial = await rl.knownPlan('partial-key');

  // 8. A learned rate older than the TTL is not trusted.
  writeFileSync(L, JSON.stringify({
    [id('stale-key')]: { rps: 50, at: new Date(Date.now() - 40 * 3600 * 1000).toISOString() },
  }));
  res.staleRps = await rl.knownRps('stale-key');
  writeFileSync(L, JSON.stringify({ [id('fresh-key')]: { rps: 50, at: new Date().toISOString() } }));
  res.freshRps = await rl.knownRps('fresh-key');

  out(JSON.stringify(res));
  process.exit(0);
}

// Grandchild B: pacing armed AND a deliberately tiny MAX_WAIT_MS, with the
// lockfile held by a "sibling process" that never releases it.
if (MODE === 'pace-lock') {
  const { CACHE_DIR } = await import(LIB('state.mjs'));
  const rl = await import(LIB('ratelimit.mjs'));
  const lock = path.join(CACHE_DIR, '.ratelimit.lock');
  writeFileSync(lock, String(process.pid));
  const t = Date.now();
  const slot = await rl.acquireSlot('lock-key');
  out(JSON.stringify({
    elapsedMs: Date.now() - t,
    maxWaitMs: Number(process.env.SURF_BRAVE_MAX_WAIT_MS),
    slot,
    siblingLockSurvived: existsSync(lock),
  }));
  process.exit(0);
}

// ------------------------------------------------------------- assertions ---

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
 * Record a reproduced defect. `broken` is TRUE while the bug is present.
 * Never touches the exit code — see the header.
 */
function bug(id, sev, where, title, broken, evidence) {
  if (broken) {
    bugs.push({ id, sev, where, title, evidence });
    out(`  ! ${id} [${sev}] ${title}\n      ${where}\n      observed: ${evidence}\n`);
  } else {
    fixed.push(id);
    out(`  ✓ ${id} no longer reproduces — ${title}\n`);
  }
}
function section(t) { out(`\n${t}\n`); }
function grandchild(mode, extraEnv = {}) {
  const env = { ...process.env, SURF_ADV_MODE: mode, ...extraEnv };
  delete env.SURF_NO_RATE_LIMIT;
  const r = spawnSync(process.execPath, [SELF], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env,
  });
  if (r.status !== 0) throw new Error(`grandchild '${mode}' exited ${r.status}: ${r.stdout}`);
  return JSON.parse(r.stdout);
}
const parens = (s) => [...s].filter(c => c === '(').length - [...s].filter(c => c === ')').length;

// Nothing in this file is allowed to open a socket. Anything that tries dies
// here rather than spending a Brave credit.
globalThis.fetch = async () => { throw new Error('ADVERSARIAL SUITE: network access is forbidden'); };

const brave = await import(LIB('providers/brave.mjs'));
const { braveProvider, mapError, resolveMode, resolveFreshness, buildWireQuery } = brave;

// ============================================================== mapError ===
// Q1: "is there a Brave error body that makes mapError say `auth` — burning the
// key — when it should not?"  Answer below: YES, and it is a precedence bug.

section('mapError: malformed bodies must never destroy a key');
const K = (s, b, h) => mapError(s, b, h).kind;

// The documented, verified matrix still holds.
eq('422 SUBSCRIPTION_TOKEN_INVALID → auth', K(422, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } }), 'auth');
eq('422 VALIDATION → config_4xx', K(422, { error: { code: 'VALIDATION' } }), 'config_4xx');
eq('400 OPTION_NOT_IN_PLAN → plan_gate', K(400, { error: { code: 'OPTION_NOT_IN_PLAN' } }), 'plan_gate');
eq('429 RATE_LIMITED → rate_limit_429', K(429, { error: { code: 'RATE_LIMITED' } }), 'rate_limit_429');

// Every shape a proxy, a CDN or a bad day can put in front of us.
eq('a null body does not burn a key', K(422, null), 'config_4xx');
eq('a body that is a bare string does not burn a key', K(422, 'gateway timeout'), 'config_4xx');
eq('a body that is an array does not burn a key', K(422, [1, 2, 3]), 'config_4xx');
eq('an undefined body does not burn a key', K(422, undefined), 'config_4xx');
eq('a numeric error.code is ignored, not stringified into a match', K(422, { error: { code: 422 } }), 'config_4xx');
eq('an error.code that is an object is ignored', K(422, { error: { code: { a: 1 } } }), 'config_4xx');
ok('meta.errors that is not an array does not throw',
  K(422, { error: { code: 'VALIDATION', meta: 'boom' } }) === 'config_4xx');
{
  const safe = (body) => { try { return mapError(422, body).kind; } catch (e) { return `THREW ${e.constructor.name}: ${e.message}`; } };
  eq('meta.errors entries with no loc do not throw',
    safe({ error: { code: 'VALIDATION', meta: { errors: [{ msg: 'x' }] } } }), 'config_4xx');
  const withNull = safe({ error: { code: 'VALIDATION', meta: { errors: [null] } } });
  bug('BUG-43', 'HIGH', 'src/lib/providers/brave.mjs:190-192',
    'fieldsFromMeta maps over meta.errors without checking the entries, so a null element makes mapError ITSELF throw a TypeError. mapError is the function whose entire job is to turn a hostile response into a classification: when it throws, asError never runs, the throw escapes doFetch as an un-kinded error and dispatch.mjs:249 files it under caller_4xx. A malformed error body therefore produces a stack trace instead of an error kind, and the key rotation logic never sees the response at all',
    typeof withNull === 'string' && withNull.startsWith('THREW'), withNull);
}
eq('meta.errors given as an object (not a list) is ignored',
  K(422, { error: { code: 'VALIDATION', meta: { errors: { loc: ['q'] } } } }), 'config_4xx');
eq('a non-JSON body reaching us as {raw} at 502 → server_5xx', K(502, { raw: '<html>bad gateway</html>' }), 'server_5xx');
eq('status 0 (a fetch shim that lost the status) does NOT burn', K(0, {}), 'caller_4xx');
eq('an unattributable 422 does not burn', K(422, {}), 'config_4xx');
eq('an unattributable 400 does not burn', K(400, {}), 'config_4xx');

bug('BUG-01', 'HIGH', 'src/lib/providers/brave.mjs:153',
  'mapError tests /TOKEN|SUBSCRIPTION/ BEFORE /PLAN/ and before the 429 branch, so any error.code merely CONTAINING those words is classified auth — and dispatch.mjs:289 burns the key permanently (until the next calendar month)',
  K(429, { error: { code: 'SUBSCRIPTION_QUOTA_EXCEEDED' } }) === 'auth'
  || K(400, { error: { code: 'OPTION_NOT_IN_SUBSCRIPTION_PLAN' } }) === 'auth',
  `429 SUBSCRIPTION_QUOTA_EXCEEDED → ${K(429, { error: { code: 'SUBSCRIPTION_QUOTA_EXCEEDED' } })}; ` +
  `400 OPTION_NOT_IN_SUBSCRIPTION_PLAN → ${K(400, { error: { code: 'OPTION_NOT_IN_SUBSCRIPTION_PLAN' } })}`);

bug('BUG-02', 'MED', 'src/lib/providers/brave.mjs:153',
  'the auth match is unanchored and status-blind: a HTTP 200 whose body happens to carry such a code burns the key',
  K(200, { error: { code: 'NO_SUBSCRIPTION_FOUND' } }) === 'auth',
  `200 + NO_SUBSCRIPTION_FOUND → ${K(200, { error: { code: 'NO_SUBSCRIPTION_FOUND' } })}`);

bug('BUG-03', 'LOW', 'src/lib/providers/brave.mjs:177',
  'status >= 500 is unbounded, so a nonsense status is reported as a Brave server error and silently retried three times',
  K(999, {}) === 'server_5xx', `999 → ${K(999, {})}`);

bug('BUG-04', 'LOW', 'src/lib/providers/brave.mjs:150',
  'err.detail is interpolated without a type check; FastAPI-shaped validation details (an array/object) reach the user as [object Object]',
  mapError(422, { error: { code: 'VALIDATION', detail: [{ msg: 'bad count' }] } }).message.includes('[object Object]'),
  JSON.stringify(mapError(422, { error: { code: 'VALIDATION', detail: [{ msg: 'bad count' }] } }).message));

// The field-naming helper must survive the same abuse.
ok('a validation error still names the offending field when meta is well formed',
  mapError(422, { error: { code: 'VALIDATION', meta: { errors: [{ loc: ['query', 'count'] }] } } }).message.includes('count'));

// ============================================================ resolveMode ===

section('resolveMode: every branch, including the ones nobody types');
eq('fast', resolveMode({ mode: 'fast' }), 'fast');
eq('normal', resolveMode({ mode: 'normal' }), 'normal');
eq('slow', resolveMode({ mode: 'slow' }), 'slow');
eq('an unknown mode falls back to normal', resolveMode({ mode: 'slwo' }), 'normal');
eq('mode wins over a conflicting legacy depth', resolveMode({ mode: 'fast', depth: 'advanced' }), 'fast');
eq('legacy depth advanced → slow', resolveMode({ depth: 'advanced' }), 'slow');
eq('legacy depth ultra-fast → fast', resolveMode({ depth: 'ultra-fast' }), 'fast');
eq('legacy depth basic → normal', resolveMode({ depth: 'basic' }), 'normal');
eq('no hints at all → normal', resolveMode({}), 'normal');
eq('a non-string mode → normal', resolveMode({ mode: 7 }), 'normal');
eq('a null args object would throw, so an empty one is the contract', resolveMode({ mode: null }), 'normal');
eq('mode is case sensitive and SLOW is not slow', resolveMode({ mode: 'SLOW' }), 'normal');

// ======================================================= resolveFreshness ===
// Q5: "can resolveFreshness emit a freshness string Brave would 422?"  YES.

section('resolveFreshness: dates are checked for SHAPE, never for existence');
eq('--time week → pw', resolveFreshness({ time: 'week' }), 'pw');
eq('--time day → pd', resolveFreshness({ time: 'day' }), 'pd');
eq('--time month → pm', resolveFreshness({ time: 'month' }), 'pm');
eq('--time year → py', resolveFreshness({ time: 'year' }), 'py');
eq('no time hints at all → undefined', resolveFreshness({}), undefined);
eq('an explicit range beats --time',
  resolveFreshness({ time: 'year', startDate: '2026-01-01', endDate: '2026-02-01' }), '2026-01-01to2026-02-01');
eq('an explicit --freshness beats everything', resolveFreshness({ freshness: 'pw', time: 'day' }), 'pw');
eq('a whitespace-only --freshness is ignored', resolveFreshness({ freshness: '   ', time: 'day' }), 'pd');
ok('only an endDate still produces a well-formed range',
  /^\d{4}-\d{2}-\d{2}to2026-01-01$/.test(resolveFreshness({ endDate: '2026-01-01' })));
ok('a datetime is narrowed to its day',
  resolveFreshness({ startDate: '2026-01-01T13:00:00Z', endDate: '2026-02-01T00:00:00Z' }) === '2026-01-01to2026-02-01');

bug('BUG-05', 'HIGH', 'src/lib/providers/brave.mjs:231-235',
  'isoDay matches ^\\d{4}-\\d{2}-\\d{2} — the SHAPE of a date, not a date. Month 13, day 45 and the year 0000 are forwarded verbatim as Brave freshness and come back 422 (which then costs a retry budget and an audit line)',
  resolveFreshness({ startDate: '2026-13-45' }) !== undefined || resolveFreshness({ startDate: '0000-00-00' }) !== undefined,
  `--start-date 2026-13-45 → ${JSON.stringify(resolveFreshness({ startDate: '2026-13-45' }))}; ` +
  `--start-date 0000-00-00 → ${JSON.stringify(resolveFreshness({ startDate: '0000-00-00' }))}`);

bug('BUG-06', 'HIGH', 'src/lib/providers/brave.mjs:222-226',
  'a start after the end is never compared, so an inverted range is sent to Brave and quietly returns nothing',
  resolveFreshness({ startDate: '2026-06-30', endDate: '2026-01-01' }) === '2026-06-30to2026-01-01',
  JSON.stringify(resolveFreshness({ startDate: '2026-06-30', endDate: '2026-01-01' })));

bug('BUG-07', 'MED', 'src/lib/providers/brave.mjs:233',
  'a date the regex cannot parse is DROPPED IN SILENCE — no warning, no error — and the search runs unfiltered. --start-date and --end-date are the only search flags with no assertEnum/numericFlag guard at the CLI (bin/surf-research-skill.mjs:199-203), so the adapter is the only line of defence and it declines to defend',
  resolveFreshness({ startDate: '01/01/2026' }) === undefined && resolveFreshness({ startDate: '12026-01-01' }) === undefined,
  `--start-date 01/01/2026 → undefined; --start-date 12026-01-01 (5-digit year) → undefined`);

bug('BUG-08', 'LOW', 'src/lib/providers/brave.mjs:219',
  'an explicit --freshness is trusted verbatim and never checked against pd|pw|pm|py|RANGE',
  resolveFreshness({ freshness: 'pz' }) === 'pz', `--freshness pz → "pz" (Brave answers 422 VALIDATION)`);

// ========================================================= buildWireQuery ===
// Q2: "can buildWireQuery emit a query Brave would reject?"  YES — truncation
// runs AFTER the operators are appended and cuts straight through them.

section('buildWireQuery: operators survive, or do they');
ok('a single --domains becomes a plain site:', buildWireQuery('q', { domains: 'a.com' }).q.endsWith('site:a.com'));
ok('several --domains are OR-grouped', buildWireQuery('q', { domains: 'a.com,b.com' }).q.includes('(site:a.com OR site:b.com)'));
ok('--exclude becomes -site:', buildWireQuery('q', { excludeDomains: 'c.com' }).q.includes('-site:c.com'));
eq('loose commas produce no empty operators', buildWireQuery('x', { domains: ',,a.com,,' }).q, 'x site:a.com');
eq('an empty --domains list changes nothing', buildWireQuery('x', { domains: '' }).q, 'x');
eq('a short query is not marked truncated', buildWireQuery('x', {}).truncated, false);
eq('quotes in the query are passed through untouched', buildWireQuery('"exact phrase"', {}).q, '"exact phrase"');
ok('a 400-char query is left exactly at the limit',
  buildWireQuery('w'.repeat(400), {}).q.length === 400 && buildWireQuery('w'.repeat(400), {}).truncated === false);
ok('a 50-word query is left exactly at the limit',
  buildWireQuery(Array(50).fill('w').join(' '), {}).truncated === false);
{
  const r = buildWireQuery('w'.repeat(401), {});
  ok('a 401-char query is truncated and says so', r.q.length === 400 && r.truncated === true);
}

{
  // 380 chars of query + " (site:a.com OR site:b.com)" = 407 > 400.
  const r = buildWireQuery('w'.repeat(380), { domains: 'a.com,b.com' });
  bug('BUG-09', 'HIGH', 'src/lib/providers/brave.mjs:257-259',
    'the 400-char/50-word truncation is applied AFTER the site: operators are appended, so it cuts through the OR group and emits an unbalanced parenthesis — a broken operator expression, exactly what the OR grouping was added to avoid',
    parens(r.q) !== 0, `tail = ${JSON.stringify(r.q.slice(-32))} (paren balance ${parens(r.q)})`);

  const w = buildWireQuery(Array(48).fill('w').join(' '), { domains: 'a.com,b.com' });
  bug('BUG-10', 'HIGH', 'src/lib/providers/brave.mjs:258-259',
    'the 50-WORD truncation has the same defect on a query that is well under 400 characters',
    parens(w.q) !== 0, `tail = ${JSON.stringify(w.q.slice(-32))} (paren balance ${parens(w.q)})`);

  const x = buildWireQuery('w'.repeat(392), { excludeDomains: 'c.com' });
  bug('BUG-11', 'HIGH', 'src/lib/providers/brave.mjs:257',
    'truncation can also amputate a -site: exclusion into a DIFFERENT, valid-looking operator, so the search silently excludes the wrong thing instead of failing',
    /-site:[^.\s]*$/.test(x.q) && !x.q.endsWith('-site:c.com'), `tail = ${JSON.stringify(x.q.slice(-16))}`);

  const qt = buildWireQuery('"' + 'w'.repeat(410) + '"', {});
  bug('BUG-12', 'MED', 'src/lib/providers/brave.mjs:257',
    'truncation cuts inside a quoted phrase and leaves an unterminated quote',
    (qt.q.split('"').length - 1) % 2 === 1, `${qt.q.split('"').length - 1} quote characters survive`);
}

bug('BUG-13', 'MED', 'src/lib/providers/brave.mjs:249-253',
  'a site: the CALLER already put in the query is not detected, so --domains ANDs a second site: onto it. Brave ANDs site: operators and no page lives on two domains, so this combination is guaranteed to return zero results — the precise failure the OR grouping exists to prevent',
  buildWireQuery('site:x.com foo', { domains: 'a.com' }).q === 'site:x.com foo site:a.com',
  JSON.stringify(buildWireQuery('site:x.com foo', { domains: 'a.com' }).q));

bug('BUG-14', 'LOW', 'src/lib/providers/brave.mjs:249-254',
  'domain tokens are never validated, so a stray space inside a --domains entry breaks the operator and injects a loose term',
  buildWireQuery('x', { domains: 'a.com, b .com' }).q.includes('site:b .com'),
  JSON.stringify(buildWireQuery('x', { domains: 'a.com, b .com' }).q));

bug('BUG-15', 'LOW', 'src/lib/providers/brave.mjs:248-254',
  'the assembled query is never re-trimmed, so an empty base query yields a leading space',
  buildWireQuery('', { domains: 'a.com' }).q.startsWith(' '),
  JSON.stringify(buildWireQuery('', { domains: 'a.com' }).q));

// ================================================================ search() ===

section('search(): a Brave response that is not the one in the docs');
let nextRes = () => ({ status: 200, body: { web: { results: [] }, query: {} } });
globalThis.fetch = async () => {
  const r = nextRes();
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new Map(Object.entries(r.headers || {})),
    text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.body)),
  };
};
const run = (args) => braveProvider.search({ query: 'q', ...args }, { key: 'k', version: '8.0.1' });
async function attempt(fn) {
  try { return { value: await fn() }; } catch (e) { return { err: e }; }
}

eq('an empty query is rejected before any socket is opened',
  (await attempt(() => braveProvider.search({ query: '   ' }, { key: 'k' }))).err.kind, 'caller_4xx');
eq('a non-string query is rejected too',
  (await attempt(() => braveProvider.search({ query: 42 }, { key: 'k' }))).err.kind, 'caller_4xx');

nextRes = () => ({ status: 200, body: { query: {} } });
eq('a response with no web block yields zero results, not a crash', (await run({})).data.results.length, 0);
nextRes = () => ({ status: 200, body: { web: { results: null }, query: {} } });
eq('web.results === null yields zero results', (await run({})).data.results.length, 0);
nextRes = () => ({ status: 200, text: '<html>we are having trouble</html>' });
eq('a 200 that is not JSON yields zero results, not a crash', (await run({})).data.results.length, 0);
nextRes = () => ({ status: 200, body: { web: { results: [] }, query: 'not an object' } });
eq('a query block that is a string does not fake more_results_available',
  (await run({})).data.more_results_available, false);
nextRes = () => ({ status: 200, body: { web: { results: [{ url: 'u', description: 'd', extra_snippets: 'nope' }] }, query: {} } });
eq('extra_snippets that is not an array is ignored', (await run({})).data.results[0].snippet_count, 1);
nextRes = () => ({ status: 200, body: { web: { results: [{ url: 'u', description: { a: 1 } }] }, query: {} } });
eq('a description that is an object degrades to empty text', (await run({})).data.results[0].content, '');

{
  nextRes = () => ({ status: 200, text: 'null' });
  const r = await attempt(() => run({}));
  bug('BUG-16', 'HIGH', 'src/lib/providers/brave.mjs:312,334',
    'a 200 whose body is the JSON literal null (a CDN, a proxy, a truncated gzip stream) reaches data.web and throws a bare TypeError. It carries no `kind`, so dispatch.mjs:249 files it under caller_4xx and rethrows: the user sees "Cannot read properties of null" instead of a Brave error, and the retry budget is skipped',
    !!r.err && r.err instanceof TypeError,
    `${r.err && r.err.constructor.name}: ${r.err && r.err.message} (kind=${r.err && r.err.kind})`);
}
{
  nextRes = () => ({ status: 200, body: { web: { results: { '0': { url: 'u' } } }, query: {} } });
  const a = await attempt(() => run({}));
  nextRes = () => ({ status: 200, body: { web: { results: 'oops' }, query: {} } });
  const b = await attempt(() => run({}));
  bug('BUG-17', 'HIGH', 'src/lib/providers/brave.mjs:312',
    'web.results is only guarded against falsiness, never against not-an-array: an object or a string reaches .map and throws an un-kinded TypeError',
    !!(a.err && b.err), `object → ${a.err && a.err.message}; string → ${b.err && b.err.message}`);
}
{
  nextRes = () => ({ status: 200, body: { web: { results: [null, { url: 'u' }] }, query: {} } });
  const r = await attempt(() => run({}));
  bug('BUG-18', 'MED', 'src/lib/providers/brave.mjs:315',
    'a single null entry inside web.results kills the whole response instead of being skipped',
    !!r.err, `${r.err && r.err.message}`);
}
{
  nextRes = () => ({ status: 200, body: { web: { results: [{ title: 't', description: 'd' }] }, query: {} } });
  const env = await run({});
  bug('BUG-19', 'MED', 'src/lib/providers/brave.mjs:322-331',
    'a result with no url is kept and shipped downstream with url === undefined — an uncitable citation in a tool whose entire output contract is citations',
    env.data.results.length === 1 && env.data.results[0].url === undefined,
    `results[0] = ${JSON.stringify(env.data.results[0])}`);
}
{
  nextRes = () => ({ status: 200, body: { web: { results: [{ url: 'u', page_age: 'yesterday' }, { url: 'v', page_age: 12345 }] }, query: {} } });
  const env = await run({});
  bug('BUG-20', 'MED', 'src/lib/providers/brave.mjs:328',
    'page_age is copied into published_date with no ISO-8601 check, although the field exists precisely because "only the ISO one may reach an LLM prompt" (brave.mjs:23-24). Anything Brave puts there — a display string, a number — becomes a date the model is told to trust',
    env.data.results[0].published_date === 'yesterday' && env.data.results[1].published_date === 12345,
    `published_date values: ${JSON.stringify(env.data.results.map(r => r.published_date))}`);
}

// A well-formed response must still behave.
nextRes = () => ({
  status: 200,
  body: {
    query: { more_results_available: true },
    web: { results: [{ url: 'https://a', title: 'T', description: 'd', extra_snippets: ['e1', 'e1'], page_age: '2026-07-04T13:05:03' }] },
  },
});
{
  const env = await run({ domains: 'a.com' });
  eq('the envelope still echoes the caller query, not the wire query', env.data.query, 'q');
  ok('the wire query is reported separately', env.data.wire_query.includes('site:a.com'));
  eq('duplicate extra_snippets are still de-duplicated', env.data.results[0].content, 'd\ne1');
  eq('an ISO page_age still lands in published_date', env.data.results[0].published_date, '2026-07-04T13:05:03');
}

// =============================================================== validate() ===

section('validate(): every branch, and the verdict it writes to disk');
nextRes = () => ({ status: 422, body: { error: { code: 'VALIDATION' } } });
{
  const v = await braveProvider.validate('k');
  ok('a q-less 422 VALIDATION proves the key is good, for free', v.valid === true && v.credits === 0 && v.free === true);
}
nextRes = () => ({ status: 422, body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'nope' } } });
{
  const v = await braveProvider.validate('k');
  ok('a rejected token is invalid with kind auth', v.valid === false && v.kind === 'auth');
}
nextRes = () => ({ status: 400, body: { error: { code: 'OPTION_NOT_IN_PLAN' } } });
eq('a plan gate proves the key works', (await braveProvider.validate('k')).valid, true);
nextRes = () => ({ status: 429, body: { error: { code: 'RATE_LIMITED' } } });
eq('a throttled probe means accepted', (await braveProvider.validate('k')).valid, true);
nextRes = () => ({ status: 200, body: { web: { results: [] } } });
{
  const v = await braveProvider.validate('k');
  ok('a 2xx probe is valid and is the only branch that bills a credit', v.valid === true && v.credits === 1);
}
nextRes = () => ({ status: 422, text: 'null' });
eq('a null body during validation does not throw', (await braveProvider.validate('k')).valid, false);
nextRes = () => ({ status: 422, text: 'not json at all' });
eq('a non-JSON validation body does not throw', (await braveProvider.validate('k')).valid, false);

// -- the expensive one -------------------------------------------------------
section('the gate: what a transient failure writes into keys.json');
{
  const { blankProvider } = await import(LIB('state.mjs'));
  const { resolveGate, gateStatus, GATE } = await import(LIB('preflight.mjs'));

  const st = { brave: { ...blankProvider(), keys: ['a-perfectly-good-key'] }, openrouter: blankProvider() };
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('getaddrinfo ENOTFOUND api.search.brave.com'); };
  const offline = await resolveGate(st, 'brave', { persist: false });

  // Now the network comes back and the key is as good as it ever was.
  calls = 0;
  globalThis.fetch = async () => ({ ok: false, status: 422, headers: new Map(), text: async () => JSON.stringify({ error: { code: 'VALIDATION' } }) });
  const back = await resolveGate(st, 'brave', { persist: false });

  bug('BUG-21', 'CRITICAL', 'src/lib/preflight.mjs:142-147 + src/lib/providers/brave.mjs:400-405',
    'validate() cannot distinguish "this key is bad" from "the network is down" — a network error and a Brave 5xx both return valid:false — and resolveGate caches that verdict into keys.json with ok:false. gateStatus then reports INVALID and resolveGate SKIPS the key without re-probing (line 142 `continue`), for the whole VALIDATION_TTL_MS of 7 DAYS. One offline moment, or one Brave outage, exits 78 on every later invocation with "every key failed validation" until the user manually re-adds the key',
    offline.verdict === GATE.INVALID && back.verdict === GATE.INVALID && calls === 0,
    `offline verdict=${offline.verdict}; reconnected verdict=${back.verdict} after ${calls} live probes; ` +
    `cached=${JSON.stringify(st.brave.validated[0])}`);

  const st5 = { brave: { ...blankProvider(), keys: ['k'] }, openrouter: blankProvider() };
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: new Map(), text: async () => '<html>maintenance</html>' });
  const outage = await resolveGate(st5, 'brave', { persist: false });
  ok('a Brave 503 during the gate is recorded the same way (same defect, second entry point)',
    outage.verdict === GATE.INVALID && st5.brave.validated[0].ok === false,
    JSON.stringify(st5.brave.validated[0]));

  // The correct half: an auth failure SHOULD stick.
  const stBad = { brave: { ...blankProvider(), keys: ['bad'] }, openrouter: blankProvider() };
  globalThis.fetch = async () => ({ ok: false, status: 422, headers: new Map(), text: async () => JSON.stringify({ error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } }) });
  eq('a genuinely rejected key is INVALID, which is correct', (await resolveGate(stBad, 'brave', { persist: false })).verdict, GATE.INVALID);
}
globalThis.fetch = async () => { throw new Error('ADVERSARIAL SUITE: network access is forbidden'); };

// ============================================================== ratelimit ===

section('ratelimit: header parsing under malformed policies');
const rl = await import(LIB('ratelimit.mjs'));
eq('the documented policy still yields 1', rl.parsePerSecond('1;w=1, 2000;w=2678400', '1, 2000'), 1);
eq('a 50 rps plan is read', rl.parsePerSecond('50;w=1, 20000000;w=2592000', null), 50);
eq('field order is irrelevant', rl.parsePerSecond('2000;w=2678400, 3;w=1', null), 3);
eq('whitespace inside the policy is tolerated', rl.parsePerSecond(' 4 ; w = 1 ', null), 4);
eq('a w=0 bucket is not a per-second bucket', rl.parsePerSecond('5;w=0', null), null);
eq('w= with no number falls back to the limit header', rl.parsePerSecond('5;w=', '9, 2000'), 9);
eq('a negative rate is refused', rl.parsePerSecond('-4;w=1', null), null);
eq('a negative limit header is refused', rl.parsePerSecond(null, '-4, 20'), null);
eq('a zero limit header is refused', rl.parsePerSecond(null, '0, 2000'), null);
eq('an empty string teaches nothing', rl.parsePerSecond('', ''), null);
eq('a fractional rate is refused rather than floored to zero', rl.parsePerSecond('0.5;w=1', null), null);
eq('a zero rate is floored to 1, never to 0', rl.parsePerSecond('0;w=1', null), 1);
eq('a non-string policy is ignored', rl.parsePerSecond({ w: 1 }, null), null);
eq('absent headers teach nothing', rl.parsePerSecond(null, null), null);
eq('monthly remaining is the second field', rl.parseMonthlyRemaining('0, 118'), 118);
eq('one field is not enough', rl.parseMonthlyRemaining('5'), null);
eq('a non-string is not enough', rl.parseMonthlyRemaining(118), null);
eq('a reset of 0 still yields the 250ms floor, never 0', rl.resetDelayMs({ get: () => '0, 100' }), 250);
eq('a negative reset yields no delay', rl.resetDelayMs({ get: () => '-1, 100' }), null);
eq('a missing reset header yields no delay', rl.resetDelayMs({ get: () => null }), null);
eq('a non-string reset yields no delay', rl.resetDelayMs({ get: () => 5 }), null);
ok('a plain-object headers bag works as well as a Headers instance',
  rl.resetDelayMs({ 'x-ratelimit-reset': '2, 100' }) > 0);
ok('the reset delay is capped at 5s of window, jitter included',
  rl.resetDelayMs({ get: () => '999999, 1' }) <= 5000);

bug('BUG-22', 'LOW', 'src/lib/ratelimit.mjs:281-283',
  'parseMonthlyRemaining trusts Number(""), which is 0 — a header with a trailing comma reports "0 requests left this month" instead of "unknown"',
  rl.parseMonthlyRemaining('1, ') === 0, `"1, " → ${rl.parseMonthlyRemaining('1, ')}`);
bug('BUG-23', 'LOW', 'src/lib/ratelimit.mjs:283',
  'a negative remaining is passed through instead of being clamped or rejected',
  rl.parseMonthlyRemaining('0, -5') === -5, `"0, -5" → ${rl.parseMonthlyRemaining('0, -5')}`);
bug('BUG-24', 'LOW', 'src/lib/ratelimit.mjs:266-269',
  'when a policy carries more than one w=1 bucket the FIRST wins rather than the smallest, so the limiter can adopt the more permissive of two contradictory allowances',
  rl.parsePerSecond('9;w=1, 1;w=1', null) === 9, `"9;w=1, 1;w=1" → ${rl.parsePerSecond('9;w=1, 1;w=1', null)}`);

section('ratelimit: SURF_NO_RATE_LIMIT=1 (this process has it set)');
eq('acquireSlot returns instantly', (await rl.acquireSlot('x')).waitedMs, 0);
eq('and reports no pacing', (await rl.acquireSlot('x')).paced, false);
eq('knownRps is Infinity', await rl.knownRps('x'), Infinity);
eq('effectiveParallelism is Infinity', await rl.effectiveParallelism(['a', 'b']), Infinity);
eq('learnFromHeaders is a no-op', await rl.learnFromHeaders('x', new Map([['x-ratelimit-policy', '50;w=1']])), null);
eq('learnFromBody is a no-op', await rl.learnFromBody('x', { error: { meta: { rate_limit: 50 } } }), null);
ok('nothing was written to the ledger while disabled',
  (await rl.knownPlan('x')) === null && (await rl.monthlyRemaining('x')) === null);
bug('BUG-25', 'LOW', 'src/lib/ratelimit.mjs:93',
  'with pacing disabled acquireSlot reports rps: Infinity, which JSON.stringify turns into null the moment it reaches any --json envelope or ledger line',
  JSON.parse(JSON.stringify(await rl.acquireSlot('x'))).rps === null,
  `JSON.stringify({rps: Infinity}) → ${JSON.stringify(await rl.acquireSlot('x'))}`);

section('ratelimit: the on-disk ledger, with pacing ARMED (separate process)');
// Q3: does a corrupted ratelimit.json take the process down?  It does not.
// Q4: can acquireSlot spin forever or overrun MAX_WAIT_MS?  Not forever — but
//     it does overrun, by the lock timeout, which is outside the budget check.
{
  const p = grandchild('pace');
  ok('a ratelimit.json that is not JSON degrades to an empty ledger instead of throwing',
    p.corrupt && p.corrupt.rps === 1 && p.corrupt.gaveUp === undefined, JSON.stringify(p.corrupt));
  ok('a `recent` that is not an array degrades, and a negative rps falls back to the default',
    p.badShape && p.badShape.rps === 1, JSON.stringify(p.badShape));
  ok('a second request on a 1 rps plan really does wait about a second',
    p.secondMs >= 900 && p.secondMs <= 2500, `first ${p.firstMs}ms, second ${p.secondMs}ms`);
  ok('the first request of a fresh window is not delayed', p.firstMs < 500, `${p.firstMs}ms`);
  eq('a learned rate older than the 24h TTL is not trusted', p.staleRps, 1);
  eq('a fresh learned rate is trusted', p.freshRps, 50);
  eq('an empty key list falls back to the conservative default', p.effEmpty, 1);
  eq('a null key list does not throw', p.effNull, 1);
  ok('a 429 body teaches the plan name and the monthly counter',
    p.monthlyAfterBody === 100 && p.planAfterBody === 'Free',
    `remaining=${p.monthlyAfterBody} plan=${p.planAfterBody}`);

  bug('BUG-26', 'HIGH', 'src/lib/ratelimit.mjs:107',
    'the window filter is `now - t < 1000`, which is TRUE for any timestamp in the future — so a clock that steps backwards (NTP, a suspended laptop, a shared HOME across machines) writes timestamps that never leave the window. The bucket is permanently full: every later acquireSlot computes a wait of ~an hour, trips the MAX_WAIT_MS escape hatch and returns gaveUp immediately, so pacing for that key is silently switched off for good and every request goes out unpaced',
    !!(p.future1 && p.future1.gaveUp && p.future2 && p.future2.gaveUp),
    `slot1=${JSON.stringify(p.future1)} in ${p.future1Ms}ms, slot2=${JSON.stringify(p.future2)} in ${p.future2Ms}ms, ` +
    `and the poisoned entry is written back (recent.length=${p.futureLedgerKept})`);

  bug('BUG-27', 'MED', 'src/lib/ratelimit.mjs:168',
    'learnFromHeaders always writes monthlyRemaining, even when the response carried no x-ratelimit-remaining header — so parseMonthlyRemaining(null) === null overwrites the exact quota learnFromBody had just extracted from a 429 body. learnFromBody carefully preserves the previous value (line 202); learnFromHeaders does not',
    p.monthlyAfterBody === 100 && p.monthlyAfterHeaders === null,
    `after the 429 body: ${p.monthlyAfterBody}; after a 200 with a policy but no remaining header: ${p.monthlyAfterHeaders} ` +
    `(plan survived: ${JSON.stringify(p.planAfterHeaders)})`);

  bug('BUG-28', 'MED', 'src/lib/ratelimit.mjs:241-249',
    'effectiveParallelism sums per KEY while the ledger buckets per KEY HASH, so the same key listed twice advertises double the real budget to the fan-out planner — the planner then launches 2 sub-agents against a 1 rps allowance and earns a 429',
    p.effDup === 2 * p.effSingle, `["dup","dup"] → ${p.effDup}, ["dup"] → ${p.effSingle}`);

  bug('BUG-29', 'LOW', 'src/lib/ratelimit.mjs:188',
    'learnFromBody bails out before recording anything when meta.rate_limit is absent, discarding the plan name and the quota counters that the same body carried',
    p.learnNoRate === null && p.planPartial === null,
    `a 429 meta with plan+quota but no rate_limit taught: plan=${JSON.stringify(p.planPartial)}`);

  bug('BUG-30', 'LOW', 'src/lib/ratelimit.mjs:113',
    'the `paced` flag is `now - startedAt > 0`, so it is true whenever the lock and the ledger read took a single millisecond — it reports pacing that never happened (brave.mjs:96 papers over this with a 250ms threshold)',
    p.corrupt && p.corrupt.paced === true && p.corrupt.waitedMs < 250,
    `an unpaced slot reported paced=${p.corrupt && p.corrupt.paced} after ${p.corrupt && p.corrupt.waitedMs}ms`);
}
{
  const q = grandchild('pace-lock', { SURF_BRAVE_MAX_WAIT_MS: '200' });
  ok('a lock held by another process never deadlocks the fleet', q.elapsedMs < 10_000, `${q.elapsedMs}ms`);
  bug('BUG-31', 'MED', 'src/lib/ratelimit.mjs:49-52,127',
    'acquireLock spins for its own 3000ms before giving up, and that spin happens BEFORE the `elapsed + wait > MAX_WAIT_MS` check — so acquireSlot can block for roughly the lock timeout past its stated ceiling. Set SURF_BRAVE_MAX_WAIT_MS to 200 and it still blocks ~3s, which is precisely the harness-timeout hazard MAX_WAIT_MS exists to prevent',
    q.elapsedMs > q.maxWaitMs * 2, `MAX_WAIT_MS=${q.maxWaitMs} but acquireSlot took ${q.elapsedMs}ms`);
  bug('BUG-32', 'MED', 'src/lib/ratelimit.mjs:62-64',
    'after the timeout the lock is unlinked and declared stale even though a live sibling may still hold it; the breaker then proceeds with locked=false, and the victim will later unlink whatever lock file exists at that moment — which may belong to a third process',
    q.siblingLockSurvived === false,
    `the sibling's lockfile was deleted by the waiter: siblingLockSurvived=${q.siblingLockSurvived}`);
}

// =================================================================== html ===

section('html: the sanitiser between Brave and the model');
const { stripHtml, decodeEntities } = await import(LIB('html.mjs'));
eq('strips highlight markup', stripHtml('up to <strong>five</strong> snippets'), 'up to five snippets');
eq('strips nested tags', stripHtml('<b><i>x</i></b>'), 'x');
eq('drops a closed script body', stripHtml('a<script>evil()</script>b'), 'a b');
eq('drops a closed style body', stripHtml('a<style>x{}</style>b'), 'a b');
eq('a script tag in capitals is matched too', stripHtml('a<SCRIPT>evil()</SCRIPT>b'), 'a b');
eq('br becomes a newline', stripHtml('a<br>b'), 'a\nb');
eq('decodes named entities', decodeEntities('a &amp; b'), 'a & b');
eq('decodes decimal entities', decodeEntities('&#8212;'), '—');
eq('decodes hex entities', decodeEntities('&#x2014;'), '—');
eq('an unknown named entity is left alone', decodeEntities('&frac12;'), '&frac12;');
eq('a malformed hex entity is left alone', decodeEntities('&#xZZ;'), '&#xZZ;');
eq('an entity with no semicolon is left alone', decodeEntities('a &amp b'), 'a &amp b');
eq('a codepoint beyond Unicode is dropped, not thrown', decodeEntities('a&#999999999;b'), 'ab');
eq('a negative-looking entity is not decoded', decodeEntities('&#-1;'), '&#-1;');
eq('decoding is single pass, so &amp;lt; does not become a tag', decodeEntities('&amp;lt;'), '&lt;');
eq('stripHtml never returns null for undefined', stripHtml(undefined), '');
eq('stripHtml never returns null for a number', stripHtml(123), '');
eq('stripHtml never returns null for an object', stripHtml({}), '');
eq('runs of whitespace are collapsed', stripHtml('a     b'), 'a b');

bug('BUG-33', 'MED', 'src/lib/html.mjs:39',
  'the tag stripper is /<[^>]+>/g, which deletes everything between a bare "<" and the next ">". Brave snippets routinely carry comparisons and code, and those come out of the sanitiser with their middle removed — silently corrupted evidence, not escaped evidence',
  stripHtml('5 < 10 and 10 > 5') !== '5 < 10 and 10 > 5',
  `"5 < 10 and 10 > 5" became ${JSON.stringify(stripHtml('5 < 10 and 10 > 5'))}`);

bug('BUG-34', 'HIGH', 'src/lib/html.mjs:34-39',
  'entities are decoded AFTER tags are stripped, so markup that arrived entity-encoded is re-materialised on the way out: the sanitiser EMITS live script markup it was called to remove. surf writes Markdown and HTML reports, so this ordering turns a Brave snippet into stored markup',
  stripHtml('&lt;script&gt;alert(1)&lt;/script&gt;').includes('<script>'),
  `an entity-encoded script tag became ${JSON.stringify(stripHtml('&lt;script&gt;alert(1)&lt;/script&gt;'))}`);

bug('BUG-35', 'MED', 'src/lib/html.mjs:36',
  'the script/style rule requires a closing tag, so a truncated snippet ending mid-script has its tag removed by the generic rule and its BODY kept',
  stripHtml('a<script>evil()').includes('evil()'),
  `"a<script>evil()" became ${JSON.stringify(stripHtml('a<script>evil()'))}`);

bug('BUG-36', 'LOW', 'src/lib/html.mjs:27',
  'safeChar only rejects codepoints outside Unicode, so C0 control characters — NUL included — are decoded into the text that later becomes JSON output and an LLM prompt',
  stripHtml('a&#0;b').length === 3,
  `"a&#0;b" produced ${stripHtml('a&#0;b').length} characters, codepoint 1 = ${stripHtml('a&#0;b').codePointAt(1)}`);

bug('BUG-37', 'LOW', 'src/lib/html.mjs:16',
  'decodeEntities returns its argument unchanged when it is not a string, so it can return a number from a function documented to return text',
  typeof decodeEntities(123) !== 'string', `typeof decodeEntities(123) is ${typeof decodeEntities(123)}`);

// ================================================== cache and the key gate ===
// The question this section exists to answer: can a cache hit serve a result
// for a key that was later burned, or for a request the flag layer would have
// refused? Yes to both.

section('cache: the TTL, the key, and what cache clear takes with it');
const { CACHE_DIR } = await import(LIB('state.mjs'));
const cache = await import(LIB('cache.mjs'));
mkdirSync(CACHE_DIR, { recursive: true });

eq('the same args hash to the same key',
  cache.cacheKey('brave', 'search', { q: 'x', max: 3 }), cache.cacheKey('brave', 'search', { q: 'x', max: 3 }));
ok('different args hash differently',
  cache.cacheKey('brave', 'search', { q: 'x' }) !== cache.cacheKey('brave', 'search', { q: 'y' }));
{
  const k = cache.cacheKey('brave', 'search', { q: 'fresh' });
  await cache.cacheSet(k, { hello: 'world' });
  eq('a fresh entry round-trips', (await cache.cacheGet(k)).hello, 'world');
  writeFileSync(path.join(CACHE_DIR, k + '.json'), '{ not json');
  eq('a corrupted cache file is a miss, not a crash', await cache.cacheGet(k), null);
  writeFileSync(path.join(CACHE_DIR, k + '.json'), JSON.stringify({ ts: Date.now() - cache.TTL_MS - 1000, data: { x: 1 } }));
  eq('an expired entry is a miss', await cache.cacheGet(k), null);
  eq('an absent entry is a miss', await cache.cacheGet('0000000000000000000000ff'), null);
}
{
  writeFileSync(path.join(CACHE_DIR, 'aaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify({ data: { stale: 'forever' } }));
  const served = await cache.cacheGet('aaaaaaaaaaaaaaaaaaaaaaaa');
  bug('BUG-38', 'MED', 'src/lib/cache.mjs:23',
    'the TTL check is Date.now() - raw.ts > TTL_MS; with no ts that comparison is NaN > TTL, which is false, so an entry without a timestamp is served forever. Any partially written or hand-edited cache file becomes immortal',
    served !== null, `an entry with no ts was served: ${JSON.stringify(served)}`);
}
bug('BUG-39', 'LOW', 'src/lib/cache.mjs:13',
  'the cache key is a hash of JSON.stringify(args), which depends on property INSERTION ORDER, so the same search assembled by two different call sites misses the cache and spends a Brave credit',
  cache.cacheKey('brave', 'search', { a: 1, b: 2 }) !== cache.cacheKey('brave', 'search', { b: 2, a: 1 }),
  'cacheKey({a,b}) differs from cacheKey({b,a})');
{
  const ledger = path.join(CACHE_DIR, 'ratelimit.json');
  writeFileSync(ledger, JSON.stringify({ someBucket: { rps: 50, plan: 'Search', at: new Date().toISOString() } }));
  await cache.cacheSet(cache.cacheKey('brave', 'search', { q: 'victim' }), { x: 1 });
  const n = await cache.cacheClear();
  bug('BUG-40', 'HIGH', 'src/lib/cache.mjs:38-43',
    'cacheClear deletes EVERY *.json in ~/.cache/surf, and the rate limiter keeps its learned ledger in that same directory as ratelimit.json. So clearing the cache throws away the per-key plan, the learned rps and the monthly counter, and the next run falls back to the conservative 1 rps assumption, pacing a 50 rps plan at one request per second',
    !existsSync(ledger), `cacheClear removed ${n} files; ratelimit.json still present: ${existsSync(ledger)}`);
}

section('dispatch: the cache is consulted before the gate and before the flags');
{
  const { dispatch } = await import(LIB('dispatch.mjs'));
  const { blankProvider } = await import(LIB('state.mjs'));
  const args = { query: 'a question answered six hours ago' };
  await cache.cacheSet(cache.cacheKey('brave', 'search', args), {
    provider: 'brave', usage: { credits: 1 }, latency_ms: 1,
    data: { query: args.query, results: [{ url: 'https://stale.example' }] },
  });
  const burned = {
    brave: { ...blankProvider(), keys: ['k1'], burned: [{ index: 0, at: new Date().toISOString(), reason: '422' }] },
    openrouter: blankProvider(), _inMemory: true,
  };
  const noKeys = { brave: blankProvider(), openrouter: blankProvider(), _inMemory: true };

  const missed = await attempt(() => dispatch('search', { query: 'never seen before' }, {}, { state: noKeys }));
  eq('a cache MISS with no usable key still fails closed', missed.err.code, 'NoProviderAvailable');
  const removed = await attempt(() => dispatch('extract', args, {}, { state: burned }));
  eq('a verb removed in v8 fails before the cache is even consulted', removed.err.code, 'UnknownOperation');

  const hitBurned = await attempt(() => dispatch('search', args, {}, { state: burned }));
  const hitNoKey = await attempt(() => dispatch('search', args, {}, { state: noKeys }));
  const hitBadProvider = await attempt(() => dispatch('search', args, { provider: 'tavily' }, { state: burned }));

  bug('BUG-41', 'MED', 'src/lib/dispatch.mjs:149-158 vs 160 and 164',
    'the cache lookup runs before buildChain, so --provider tavily, which buildChain rejects with UnknownProvider, is accepted and answered with Brave results whenever the query happens to be cached. A flag the tool promises to validate is validated only on a cache miss, which makes the error non-deterministic',
    !!(hitBadProvider.value && hitBadProvider.value.data),
    `--provider tavily returned ${JSON.stringify(hitBadProvider.value && hitBadProvider.value.data.results)} instead of throwing UnknownProvider`);

  bug('BUG-42', 'INFO', 'src/lib/dispatch.mjs:147-158 (documented as deliberate)',
    'a cache hit is also served with every key burned and with no key configured at all, so "no valid Brave key means exit 78 before any work runs" holds on a cache miss but not on a cache hit, for up to SURF_CACHE_TTL (6h by default). The comment above the block argues this is correct, since a hit costs no credit and no network; it is recorded here because it is the one hole in the v8 invariant and a reader of that invariant would not expect it',
    !!(hitBurned.value && hitNoKey.value),
    `burned key: ${hitBurned.value ? 'served from cache' : 'threw'}; no key at all: ${hitNoKey.value ? 'served from cache' : 'threw'}`);
}

// ================================================================ summary ===

section('summary');
out(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) out(`  x ${f}\n`);
out(`${bugs.length} defect(s) reproduced${fixed.length ? `, ${fixed.length} no longer reproduce (${fixed.join(', ')})` : ''}\n`);
const bySev = {};
for (const b of bugs) bySev[b.sev] = (bySev[b.sev] || 0) + 1;
for (const sev of ['CRITICAL', 'HIGH', 'MED', 'LOW', 'INFO']) {
  if (bySev[sev]) out(`  ${sev}: ${bySev[sev]}\n`);
}
for (const b of bugs) out(`  ${b.id} [${b.sev}] ${b.where}\n`);

if (failures.length) process.exit(1);
out('brave-limits-ok\n');
