#!/usr/bin/env node
// Offline tests for the Brave-only surf: the adapter, the flag parser, the
// deepening frontier and the key gate. No network, no real keys — the suite
// re-execs itself with HOME pointed at a throwaway directory, then stubs fetch.
//
// Every assertion here corresponds to a defect that was live in v7. They are
// regression tests, not coverage decoration.
//
// Run: node ./test/brave.mjs   (or npm test)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

if (!process.env.SURF_BRAVE_TEST_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-brave-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_BRAVE_TEST_CHILD: '1',
      SURF_QUIET: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      // The rate limiter is exercised directly in its own section; leaving it
      // armed everywhere else would add a second of latency per stubbed call.
      SURF_NO_RATE_LIMIT: '1',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

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
async function throws(fn, code) {
  try { await fn(); return false; } catch (e) { return code ? e.code === code : true; }
}

// ---------------------------------------------------------------- flags ---

section('flags: --flag=value, the spelling the docs promise');
const { parseFlags, FlagError, numericFlag, assertEnum, intOr, compactObject } =
  await import('../src/lib/flags.mjs');
{
  // v7 produced {"sub-agents=10": "q"} and an EMPTY positional list, so the
  // question vanished and buildBrief threw "a question is required".
  const { pos, flags } = parseFlags(['--sub-agents=10', 'my question']);
  eq('--sub-agents=10 keeps the question', pos[0], 'my question');
  eq('--sub-agents=10 parses the value', flags['sub-agents'], '10');
}
eq('--json=false disables rather than enables', parseFlags(['--json=false', 'q']).flags.json, false);
eq('--json=true still enables', parseFlags(['--json=true', 'q']).flags.json, true);
eq('space form still works', parseFlags(['--sub-agents', '7', 'q']).flags['sub-agents'], '7');
ok('a valued flag with no value is a usage error, not boolean true',
  await throws(() => parseFlags(['--concurrency', '--json', 'q']), 'FLAG_USAGE'));
ok('a valued flag must not eat the question',
  await throws(() => parseFlags(['--max']), 'FLAG_USAGE'));
eq('booleans are untouched', parseFlags(['--quiet', 'q']).flags.quiet, true);

section('flags: numbers and enums are checked, not coerced silently');
eq('non-numeric --max falls back instead of becoming NaN', intOr('abc', { min: 1, max: 20, fallback: 10 }), 10);
eq('fractional --max floors', intOr('3.7', { min: 1, max: 20, fallback: 10 }), 3);
eq('out-of-range --max clamps', intOr('999', { min: 1, max: 20, fallback: 10 }), 20);
ok('numericFlag rejects a typo', await throws(() => numericFlag('ten', { name: '--sub-agents', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('numericFlag rejects out of range', await throws(() => numericFlag('99', { name: '--sub-agents', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('assertEnum rejects a typo', await throws(() => assertEnum('--mode', 'slwo', ['fast', 'normal', 'slow']), 'FLAG_USAGE'));
eq('assertEnum passes a valid value', assertEnum('--mode', 'slow', ['fast', 'normal', 'slow']), 'slow');
eq('assertEnum ignores an absent flag', assertEnum('--mode', undefined, ['fast']), undefined);
ok('compactObject drops NaN', !('count' in compactObject({ count: NaN, q: 'x' })));
ok('compactObject drops Infinity', !('n' in compactObject({ n: Infinity })));

// ------------------------------------------------------------------ html ---

section('html: Brave snippets are markup, and it must not reach the model');
const { stripHtml, decodeEntities } = await import('../src/lib/html.mjs');
eq('strips <strong> highlights', stripHtml('up to <strong>five</strong> snippets'), 'up to five snippets');
eq('decodes named entities', decodeEntities('a &amp; b'), 'a & b');
eq('decodes numeric entities', decodeEntities('&#8212;'), '—');
eq('decodes hex entities', decodeEntities('&#x2014;'), '—');
eq('drops script bodies', stripHtml('a<script>evil()</script>b'), 'a b');
eq('never returns null', stripHtml(undefined), '');

// ------------------------------------------------------------- ratelimit ---

section('ratelimit: the plan is learned from Brave, never guessed');
const rl = await import('../src/lib/ratelimit.mjs');
eq('reads the w=1 bucket from the policy header', rl.parsePerSecond('1;w=1, 2000;w=2678400', '1, 2000'), 1);
eq('reads a 50 rps plan', rl.parsePerSecond('50;w=1, 20000000;w=2592000', null), 50);
eq('field order is irrelevant', rl.parsePerSecond('2000;w=2678400, 3;w=1', null), 3);
eq('falls back to the limit header', rl.parsePerSecond(null, '7, 2000'), 7);
eq('absent headers teach nothing', rl.parsePerSecond(null, null), null);
eq('monthly remaining is the second field', rl.parseMonthlyRemaining('0, 118'), 118);
eq('monthly remaining needs both fields', rl.parseMonthlyRemaining('5'), null);
ok('429 backoff comes from x-ratelimit-reset (Brave sends no Retry-After)',
  rl.resetDelayMs({ get: (k) => (k === 'x-ratelimit-reset' ? '1, 183945' : null) }) > 0);
eq('no reset header → no derived delay', rl.resetDelayMs({ get: () => null }), null);

// ---------------------------------------------------------------- brave ---

section('brave adapter: the request');
const brave = await import('../src/lib/providers/brave.mjs');
const { braveProvider } = brave;

let lastUrl = null;
let lastHeaders = null;
let nextResponse = () => ({ status: 200, body: { web: { results: [] }, query: {} } });
globalThis.fetch = async (url, init = {}) => {
  lastUrl = new URL(String(url));
  lastHeaders = init.headers || {};
  const r = nextResponse(lastUrl);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new Map(Object.entries(r.headers || {})),
    text: async () => JSON.stringify(r.body),
  };
};
const P = (k) => lastUrl.searchParams.get(k);
const run = (args) => braveProvider.search({ query: 'q', ...args }, { key: 'test-key', version: '8.0.0' });

await run({});
eq('no --max → mode default (normal = 10)', P('count'), '10');
eq('highlight markup is switched off at the source', P('text_decorations'), '0');
eq('extra snippets are requested (the one real quality lever)', P('extra_snippets'), 'true');
eq('auth uses the subscription-token header', lastHeaders['X-Subscription-Token'], 'test-key');
ok('gzip is requested', String(lastHeaders['Accept-Encoding']).includes('gzip'));

await run({ mode: 'fast' });   eq('--mode fast → count 5', P('count'), '5');
await run({ mode: 'slow' });   eq('--mode slow → count 20', P('count'), '20');
await run({ depth: 'advanced' }); eq('legacy --depth advanced still maps to slow', P('count'), '20');
await run({ mode: 'slow', max: 3 }); eq('explicit --max overrides the mode', P('count'), '3');

// The v7 blocker: clamp(NaN,1,20) is NaN, and NaN survived the param filter as
// the literal string "NaN", which Brave 422s — and the 422 burned every key.
await run({ max: 'abc', offset: 'zzz' });
ok('a non-numeric --max never reaches the wire', !lastUrl.href.includes('NaN'));
eq('a non-numeric --max falls back to the mode default', P('count'), '10');
eq('a non-numeric --offset is dropped', P('offset'), null);
await run({ max: '3.7', offset: '1.9' });
eq('fractional --max floors', P('count'), '3');
eq('fractional --offset floors', P('offset'), '1');
await run({ offset: 99 }); eq('--offset clamps to Brave\'s max of 9', P('offset'), '9');

section('brave adapter: flags that used to be accepted and silently discarded');
await run({ time: 'week' });  eq('--time week → freshness pw', P('freshness'), 'pw');
await run({ time: 'day' });   eq('--time day → freshness pd', P('freshness'), 'pd');
await run({ startDate: '2026-01-01', endDate: '2026-06-30' });
eq('a date range becomes Brave\'s range form', P('freshness'), '2026-01-01to2026-06-30');
await run({ time: 'year', startDate: '2026-01-01', endDate: '2026-02-01' });
eq('an explicit range beats --time', P('freshness'), '2026-01-01to2026-02-01');
await run({ topic: 'news' }); eq('--topic news → result_filter news', P('result_filter'), 'news');

await run({ domains: 'a.com' });
ok('a single --domains becomes site:', P('q').includes('site:a.com'));
await run({ domains: 'a.com,b.com' });
// site:a site:b is ANDed by Brave, and no page is on two domains — it returns
// nothing. The OR grouping is what makes multi-domain filtering work at all.
ok('multiple --domains are OR-grouped', P('q').includes('(site:a.com OR site:b.com)'));
await run({ excludeDomains: 'c.com' });
ok('--exclude becomes -site:', P('q').includes('-site:c.com'));
{
  const env = await braveProvider.search(
    { query: 'original words', domains: 'a.com' },
    { key: 'k', version: '8' },
  );
  eq('the envelope echoes the user query, not the wire query', env.data.query, 'original words');
  ok('the wire query is reported separately', env.data.wire_query.includes('site:a.com'));
}
{
  const long = 'word '.repeat(80);
  await run({ query: long });
  ok('an over-long query is truncated to Brave\'s limit', P('q').length <= brave.MAX_QUERY_CHARS);
}

section('brave adapter: the response');
nextResponse = () => ({
  status: 200,
  body: {
    query: { more_results_available: true, search_operators: { applied: true } },
    web: {
      results: [{
        title: 'A <strong>Title</strong>',
        url: 'https://a.com/1',
        description: 'main <strong>snippet</strong> &amp; more',
        extra_snippets: ['second excerpt', 'third excerpt', 'second excerpt'],
        page_age: '2026-07-04T13:05:03',
        age: 'July 4, 2026',
      }],
    },
  },
});
{
  const env = await run({});
  const r = env.data.results[0];
  ok('markup is stripped from the title', !/[<>]/.test(r.title));
  ok('markup is stripped from the content', !/[<>]/.test(r.content));
  ok('entities are decoded in the content', r.content.includes('&') && !r.content.includes('&amp;'));
  ok('extra snippets are appended to the content', r.content.includes('second excerpt') && r.content.includes('third excerpt'));
  eq('duplicate excerpts are not repeated', r.content.split('second excerpt').length - 1, 1);
  eq('snippet_count reports the real depth', r.snippet_count, 4);
  // v7 put the human string in published_date, which then reached a prompt that
  // explicitly demands date rigour.
  eq('published_date is the ISO page_age', r.published_date, '2026-07-04T13:05:03');
  eq('the human string is kept separately for humans', r.age_text, 'July 4, 2026');
  eq('more_results_available is surfaced', env.data.more_results_available, true);
  // /web/search has no synthesized answer; v7 read a summarizer block that is
  // never present, so `answer` was permanently undefined while pretending not
  // to be.
  eq('no fabricated answer', env.data.answer, undefined);
}
nextResponse = () => ({ status: 200, body: { query: {}, web: { results: [{ url: 'u', title: 't', description: 'd' }] } } });
{
  const env = await run({});
  eq('an absent more_results_available reads as false, not truthy', env.data.more_results_available, false);
  eq('a result with no page_age has no published_date', env.data.results[0].published_date, undefined);
}

section('brave adapter: errors are told apart by error.code, not by status');
const err = (status, body) => braveProvider.mapError(status, body);
// All three of these are 4xx. v7 classified 422 as `auth` unconditionally, so a
// single bad parameter burned every key in the ring, permanently.
eq('422 SUBSCRIPTION_TOKEN_INVALID → auth (burn the key)',
  err(422, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', meta: { component: 'authentication' } } }).kind, 'auth');
eq('422 VALIDATION → config_4xx (the caller is wrong, keep the key)',
  err(422, { error: { code: 'VALIDATION', meta: { errors: [{ loc: ['query', 'count'] }] } } }).kind, 'config_4xx');
// OPTION_NOT_IN_PLAN also carries meta.component === 'authentication', so
// branching on that field would burn a perfectly good key.
eq('400 OPTION_NOT_IN_PLAN → plan_gate (the key is fine, the plan is not)',
  err(400, { error: { code: 'OPTION_NOT_IN_PLAN', meta: { component: 'authentication' } } }).kind, 'plan_gate');
ok('a validation error names the offending parameter',
  err(422, { error: { code: 'VALIDATION', detail: 'bad', meta: { errors: [{ loc: ['query', 'count'] }] } } }).message.includes('count'));
eq('429 → rate_limit_429', err(429, { error: { code: 'RATE_LIMITED' } }).kind, 'rate_limit_429');
eq('401 → auth', err(401, {}).kind, 'auth');
eq('500 → server_5xx', err(500, {}).kind, 'server_5xx');
eq('an unattributable 4xx does NOT burn a key', err(422, {}).kind, 'config_4xx');

section('brave adapter: key validation is free');
nextResponse = () => ({ status: 422, body: { error: { code: 'VALIDATION', meta: { errors: [{ loc: ['query', 'q'] }] } } } });
{
  const v = await braveProvider.validate('good-key');
  ok('a q-less probe that fails validation proves the key is GOOD', v.valid === true);
  eq('and it costs nothing', v.credits, 0);
  eq('and it is marked as a free probe', v.free, true);
}
nextResponse = () => ({ status: 422, body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'nope' } } });
{
  const v = await braveProvider.validate('bad-key');
  eq('a rejected token is invalid', v.valid, false);
  eq('with the auth kind', v.kind, 'auth');
}
nextResponse = () => ({ status: 400, body: { error: { code: 'OPTION_NOT_IN_PLAN' } } });
eq('a plan gate still proves the key itself works', (await braveProvider.validate('k')).valid, true);
nextResponse = () => ({ status: 429, body: { error: { code: 'RATE_LIMITED' } } });
eq('a throttled probe means accepted, not invalid', (await braveProvider.validate('k')).valid, true);

// -------------------------------------------------------------- frontier ---

section('frontier: deepening is a tree, not a longer flat list');
const { Frontier, makeNode, queryKey } = await import('../src/lib/ai/frontier.mjs');
// Short tokens are dropped as noise — but a version number is a short token,
// and collapsing it would silently refuse to research the second question.
ok('version numbers keep queries distinct', queryKey('gpt 4 pricing') !== queryKey('gpt 5 pricing'));
ok('punctuation and case are ignored', queryKey('Brave API, limits!') === queryKey('brave api limits'));
{
  const f = new Frontier({ maxDepth: 2 });
  ok('a fresh query is admitted', f.admit(makeNode({ q: 'brave rate limits', sub: 'sq1' })).admitted);
  const dup = f.admit(makeNode({ q: 'BRAVE rate limits', sub: 'sq1' }));
  eq('a near-duplicate is refused', dup.admitted, false);
  eq('too deep is refused', f.admit(makeNode({ q: 'x y z deep', sub: 'sq1', depth: 5 })).admitted, false);
  eq('below the priority floor is refused', f.admit(makeNode({ q: 'trivia aside', sub: 'sq1', priority: 0 })).admitted, false);
  // A rejected candidate that is forgotten gets re-proposed every round, and
  // the loop never converges.
  eq('every rejection is recorded, never silently dropped', f.rejected.length, 3);
  f.closeBranch('sq1', 'answered');
  eq('a closed branch refuses new queries', f.admit(makeNode({ q: 'brand new angle here', sub: 'sq1' })).admitted, false);
}
{
  const f = new Frontier({ maxDepth: 3 });
  // One hot branch with many queries, three thin ones with a few.
  for (let i = 0; i < 8; i++) f.admit(makeNode({ q: `hot topic number ${i} alpha`, sub: 'sq1', priority: 0.95 }));
  for (const sub of ['sq2', 'sq3', 'sq4']) f.admit(makeNode({ q: `${sub} lonely question here`, sub, priority: 0.4 }));
  const wave = f.popWave(6, { wave: 1 });
  eq('the wave never exceeds --sub-agents', wave.length, 6);
  const subs = new Set(wave.map(n => n.sub));
  // Without a per-branch quota the 0.95-priority branch takes all six slots and
  // the other three sub-questions are never researched at all.
  ok('the per-branch quota stops one branch starving the rest', subs.size >= 3);
}
{
  const f = new Frontier();
  for (let i = 0; i < 3; i++) f.admit(makeNode({ q: `thin branch query ${i} beta`, sub: 'sqX' }));
  eq('one barren wave is not enough to close a branch', f.noteMiss('sqX'), false);
  eq('two barren waves close it', f.noteMiss('sqX'), true);
  eq('closing drops its pending queries', f.size, 0);
}
{
  const f = new Frontier();
  f.admit(makeNode({ q: 'contested claim check alpha', sub: 'sq1', kind: 'verify', priority: 0.5 }));
  for (let i = 0; i < 9; i++) f.admit(makeNode({ q: `ordinary widening query ${i}`, sub: 'sq1', priority: 0.99 }));
  const wave = f.popWave(10, { wave: 1 });
  ok('verification outranks widening once a claim is contested',
    wave.some(n => n.kind === 'verify'));
}

// ------------------------------------------------------------- preflight ---

section('preflight: the hard stop');
const { loadState, saveStateAtomic, setValidation, markBurned, blankProvider } =
  await import('../src/lib/state.mjs');
const { gateStatus, resolveGate, GATE, formatGate, EXIT_CONFIG, assertProviderReady } =
  await import('../src/lib/preflight.mjs');

eq('exit code is EX_CONFIG, distinct from 1 and 2', EXIT_CONFIG, 78);
{
  const st = { brave: blankProvider() };
  eq('no key at all', gateStatus(st, 'brave').verdict, GATE.MISSING);
}
{
  const st = { brave: { ...blankProvider(), keys: ['k1'] } };
  eq('an unproven key is not yet trusted', gateStatus(st, 'brave').verdict, GATE.UNVALIDATED);
  setValidation(st, 'brave', 0, { ok: true });
  eq('a cached good verdict is enough', gateStatus(st, 'brave').verdict, GATE.READY);
  // Proof from the live API beats a week-old cache entry.
  markBurned(st, 'brave', 0, '422');
  eq('a burn overrides the cached verdict', gateStatus(st, 'brave').verdict, GATE.BURNED);
}
{
  const st = { brave: { ...blankProvider(), keys: ['k1'], cooldowns: [{ index: 0, until: new Date(Date.now() + 60_000).toISOString() }] } };
  eq('a rate-limited key is cooling, not missing', gateStatus(st, 'brave').verdict, GATE.COOLING);
}
{
  const st = { brave: { ...blankProvider(), keys: ['k1', 'k2'] } };
  setValidation(st, 'brave', 0, { ok: false, reason: 'bad' });
  eq('a proven-bad key falls through to the next one', gateStatus(st, 'brave').index, 1);
  setValidation(st, 'brave', 1, { ok: false, reason: 'bad' });
  eq('all keys proven bad is INVALID, not UNVALIDATED', gateStatus(st, 'brave').verdict, GATE.INVALID);
}
for (const v of [GATE.MISSING, GATE.BURNED, GATE.COOLING, GATE.INVALID]) {
  const { code, text } = formatGate(v, 'detail here', 'brave');
  ok(`${v} produces an actionable message`, text.includes('Fix') || text.includes('Get a key'));
  ok(`${v} carries a machine-readable code`, /^BraveKey/.test(code));
}
{
  // The cached path must never touch the network.
  let calls = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('should not be called'); };
  const st = { brave: { ...blankProvider(), keys: ['k1'] } };
  setValidation(st, 'brave', 0, { ok: true });
  const res = await resolveGate(st, 'brave', { persist: false });
  eq('a cached verdict resolves the gate offline', res.verdict, GATE.READY);
  eq('and makes no request at all', calls, 0);
  globalThis.fetch = prev;
}
{
  const st = { brave: blankProvider() };
  let threw = null;
  try { await assertProviderReady(st, 'brave', { persist: false }); } catch (e) { threw = e; }
  ok('the gate throws rather than returning a degraded result', threw !== null);
  eq('and it carries exit 78', threw.exitCode, 78);
  eq('and a stable code', threw.code, 'BraveKeyMissing');
}

section('state: the validation cache must survive a save');
{
  const st = await loadState();
  st.brave.keys = ['persisted-key'];
  setValidation(st, 'brave', 0, { ok: true, status: 200 });
  await saveStateAtomic(st);
  const again = await loadState();
  // normalizeProvider is a WHITELIST: a field it does not list is silently
  // dropped on every write, which would make the cache a no-op.
  eq('validated survives the normalize whitelist', (again.brave.validated || []).length, 1);
  eq('and keeps its verdict', again.brave.validated[0].ok, true);
}

// ------------------------------------------------------------- providers ---

section('keys list --json must not leak raw keys');
{
  // This package exists to be driven by AI agents, whose stdout lands in
  // transcripts, handoff files and task plans. The human-readable listing
  // always masked; the JSON form did not, which made `keys list --json` a
  // one-command key exfiltration path for anything that logs its own output.
  const { keysList } = await import('../src/lib/keys-cmd.mjs');
  const { loadState: ls, saveStateAtomic: save } = await import('../src/lib/state.mjs');
  const st = await ls();
  st.brave.keys = ['BSA-super-secret-key-value-0001', 'BSA-super-secret-key-value-0002'];
  await save(st);

  const masked = await keysList([], { json: true });
  const raw = JSON.stringify(masked.state);
  ok('the raw key never appears in --json output', !raw.includes('super-secret-key-value'));
  ok('keys are masked, not removed', masked.state.brave.keys[0].includes('…'));
  eq('both keys are still listed', masked.state.brave.keys.length, 2);
  eq('key_count is reported', masked.state.brave.key_count, 2);
  // check-surf-skill.mjs counts state.brave.keys.length off this output.
  ok('the shape consumers depend on survives',
    Array.isArray(masked.state.brave.burned) && Array.isArray(masked.state.brave.validated));

  const unsafe = await keysList([], { json: true, 'unsafe-show-keys': true });
  ok('--unsafe-show-keys opts back in', JSON.stringify(unsafe.state).includes('super-secret-key-value'));

  const human = await keysList([], {});
  ok('the human listing still masks too', !human.text.includes('super-secret-key-value'));

  st.brave.keys = [];
  await save(st);
}

section('providers: there is exactly one search backend');
const providers = await import('../src/lib/providers/index.mjs');
eq('one provider registered', Object.keys(providers.PROVIDERS).join(','), 'brave');
eq('search routes to brave alone', providers.capabilityMap.search.join(','), 'brave');
eq('no extract capability exists', providers.capabilityMap.extract, undefined);
eq('no crawl capability exists', providers.capabilityMap.crawl, undefined);
eq('no research capability exists', providers.capabilityMap.research, undefined);
ok('no keyless escape hatch is exported', providers.KEYLESS_PROVIDERS === undefined);

section('library: removed verbs fail loudly instead of vanishing');
const lib = await import('../src/index.mjs');
for (const name of ['extract', 'crawl', 'map', 'research', 'researchStart', 'researchPoll']) {
  ok(`${name}() throws RemovedInV8`, await throws(() => lib[name]('x'), 'RemovedInV8'));
}
ok('search is still exported', typeof lib.search === 'function');
ok('the gate is exported for library callers', typeof lib.GateError === 'function');

// ---------------------------------------------------------------- summary ---

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('brave-ok\n');
