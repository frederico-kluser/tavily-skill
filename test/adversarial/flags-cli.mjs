#!/usr/bin/env node
// Adversarial tests for the CLI flag/argument surface of surf-agent-skill.
//
// This suite is a BUG HUNT, not coverage decoration. It attacks
//   · src/lib/flags.mjs        (parseFlags, assertEnum, numericFlag, intOr,
//                               clamp, splitList, compactObject, maskKey,
//                               trunc, flat)
//   · bin/surf-research-skill.mjs (buildSearchArgs, resolveSubAgents,
//                               readListFile, the command switch, exit codes)
//   · bin/surf-search-normal.mjs / bin/surf-search-unlimit.mjs (argv, --help,
//                               --version, the gate ordering)
//   · src/lib/ai/cli.mjs       (buildBrief, the --mode aliasing, reportAiError)
//
// TWO KINDS OF ASSERTION, COUNTED SEPARATELY:
//   ok()/eq()  — behavior that is CORRECT today and must stay correct.
//                A failure here exits 1 and turns the repo gate red.
//   bug()      — a DEFECT proven to exist. It never affects the exit code.
//                It prints "STILL PRESENT" while the defect reproduces and
//                "APPEARS FIXED" once someone fixes it, so the fixer gets a
//                signal without the gate going red in the meantime.
//
// OFFLINE BY CONSTRUCTION. The Brave account has a hard monthly quota, so
// there is no network here at all: the suite re-execs itself with HOME in a
// throwaway directory holding a PRE-VALIDATED fake Brave key (the gate then
// resolves from cache and never dials out), points SURF_BRAVE_API_BASE at
// brave.invalid, and stubs globalThis.fetch for the in-process adapter probes.
// The few child-process cases that do reach dispatch only ever resolve
// brave.invalid, a reserved TLD that cannot exist.
//
// Run: node ./test/adversarial/flags-cli.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const BIN = (n) => path.join(ROOT, 'bin', n);

// ---------------------------------------------------------------- harness ---

if (!process.env.SURF_ADV_FLAGS_CHILD) {
  const home = mkdtempSync(path.join(tmpdir(), 'surf-adv-flags-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  // A pre-validated key so the preflight gate (exit 78) resolves from the
  // cache. Without it every CLI probe below would exit 78 and prove nothing
  // about the flag surface — and validating for real would cost quota.
  writeFileSync(
    path.join(home, '.config', 'surf', 'keys.json'),
    JSON.stringify({
      schema_version: 1,
      brave: {
        keys: ['brv-adv-test-key-0000'], current: 0, burned: [], cooldowns: [],
        validated: [{ index: 0, at: new Date().toISOString(), ok: true, status: 200, reason: null }],
      },
      openrouter: { keys: [], current: 0, burned: [], cooldowns: [], validated: [] },
      last_ok_provider: null,
    }, null, 2),
  );
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_ADV_FLAGS_CHILD: '1',
      SURF_ADV_HOME: home,
      SURF_QUIET: '1',
      SURF_NO_RATE_LIMIT: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      SURF_OPENROUTER_BASE: 'https://openrouter.invalid/api/v1',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

const HOME = process.env.SURF_ADV_HOME;

// ------------------------------------------------------------ assertions ---

let passed = 0;
const failures = [];
let bugsOpen = 0;
let bugsFixed = 0;
const bugRows = [];

function ok(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    process.stdout.write(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { process.stdout.write(`\n${t}\n`); }

/**
 * Record a proven defect. `reproduces` must be TRUE while the bug is live.
 * Never touches the exit code: a known bug must not turn the repo gate red.
 */
function bug(id, severity, where, what, reproduces) {
  bugRows.push({ id, severity, where, what, open: !!reproduces });
  if (reproduces) {
    bugsOpen++;
    process.stdout.write(`  ⚠ BUG#${id} [${severity}] STILL PRESENT — ${what}\n      ${where}\n`);
  } else {
    bugsFixed++;
    process.stdout.write(`  ✓ BUG#${id} [${severity}] APPEARS FIXED — ${what}\n      ${where}\n`);
  }
}

async function throws(fn, code) {
  try { await fn(); return false; } catch (e) { return code ? e.code === code : true; }
}
async function caught(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/** Spawn a bin. Never reaches a real endpoint: SURF_BRAVE_API_BASE is invalid. */
function cli(binName, args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN(binName), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 60_000,
  });
  return {
    code: r.status,
    out: r.stdout || '',
    err: r.stderr || '',
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
  };
}

const {
  parseFlags, FlagError, assertEnum, numericFlag, intOr, clamp,
  splitList, compactObject, maskKey, trunc, flat, ceilDiv,
} = await import('../../src/lib/flags.mjs');

// ============================================================================
// Q2 — does parseFlags ever LOSE or DUPLICATE a positional argument?
// ============================================================================

section('parseFlags: positional integrity — the contract that must hold');
{
  const { pos, flags } = parseFlags(['a', 'b', 'c']);
  eq('plain positionals are kept in order', pos.join('|'), 'a|b|c');
  eq('and nothing is invented', Object.keys(flags).length, 0);
}
{
  const { pos, flags } = parseFlags(['--max=5', 'alpha', '--json', 'beta', '--quiet']);
  eq('flags interleaved with positionals do not reorder them', pos.join('|'), 'alpha|beta');
  eq('--max=5 parses its value', flags.max, '5');
  eq('a boolean switch does not eat the next positional', flags.json, true);
  eq('a trailing boolean switch is still set', flags.quiet, true);
}
eq('an `=` inside the value survives', parseFlags(['--goggles=a=b=c']).flags.goggles, 'a=b=c');
eq('an empty positional string is preserved, not dropped', parseFlags(['']).pos.length, 1);
eq('a unicode positional round-trips',
  parseFlags(['o que é açúcar 🌊 ①']).pos[0], 'o que é açúcar 🌊 ①');
eq('a positional that merely contains -- is untouched',
  parseFlags(['why--not']).pos[0], 'why--not');
{
  // Last-wins on a repeated flag. Documented here so a future "collect into an
  // array" change is a deliberate decision, not an accident.
  const { pos, flags } = parseFlags(['--max', '3', '--max', '5', 'q']);
  eq('a repeated flag keeps the LAST value', flags.max, '5');
  eq('and a repeated flag consumes both values, leaving the question intact', pos.join('|'), 'q');
}
eq('a negative value is passed through verbatim at parse time', parseFlags(['--max=-5']).flags.max, '-5');
eq('scientific notation is passed through verbatim', parseFlags(['--max=1e3']).flags.max, '1e3');
eq('a quoted value keeps its inner spaces', parseFlags(['--task', 'a b  c']).flags.task, 'a b  c');
ok('a VALUED flag with a missing value is a usage error',
  await throws(() => parseFlags(['--sub-agents']), 'FLAG_USAGE'));
ok('a VALUED flag followed by another flag is a usage error',
  await throws(() => parseFlags(['--sub-agents', '--json', 'q']), 'FLAG_USAGE'));

section('parseFlags: BUGS ENCONTRADOS — arguments that vanish');
{
  // `--` is the POSIX end-of-options separator. Here it is treated as a flag
  // whose name is the empty string, and it eats the token after it.
  const { pos, flags } = parseFlags(['--', 'my query']);
  bug(1, 'HIGH', 'src/lib/flags.mjs:67-78',
    '`--` (end-of-options) is parsed as a flag named "" and SWALLOWS the next positional',
    pos.length === 0 && flags[''] === 'my query');
}
{
  // The VALUED_FLAGS list fixed this for KNOWN flags only. Any unknown flag
  // (a typo, a flag from an older version, a flag a wrapper adds) still eats
  // the question.
  const { pos, flags } = parseFlags(['--deep', 'how do rate limits work']);
  bug(2, 'HIGH', 'src/lib/flags.mjs:70-78',
    'an UNKNOWN flag swallows the following positional (typo `--deep` eats the question)',
    pos.length === 0 && flags.deep === 'how do rate limits work');
}
{
  const { pos, flags } = parseFlags(['---x', 'q']);
  bug(3, 'LOW', 'src/lib/flags.mjs:67',
    '`---x` yields the flag key "-x" and swallows the next positional',
    pos.length === 0 && flags['-x'] === 'q');
}
{
  const { pos, flags } = parseFlags(['--=x', 'q']);
  bug(4, 'LOW', 'src/lib/flags.mjs:60',
    '`--=x` yields the flag key "=x" (the `eq > 2` guard skips it) and swallows the positional',
    pos.length === 0 && flags['=x'] === 'q');
}
{
  // A single-dash typo is not a flag at all — it becomes part of the question.
  const { pos } = parseFlags(['-q', 'how do rate limits work']);
  bug(5, 'HIGH', 'src/lib/flags.mjs:55',
    'a single-dash token is treated as a POSITIONAL, so `-q "question"` researches the literal question "-q question" and spends quota',
    pos.length === 2 && pos[0] === '-q');
}
{
  // flags.mjs:26-30 states the intent: "A valued flag whose next token is
  // missing ... Both directions are now a hard usage error instead of a wrong
  // answer." The `=` form never reaches that guard.
  const spaceForm = await throws(() => parseFlags(['--sub-agents']), 'FLAG_USAGE');
  const eqForm = parseFlags(['--sub-agents=', 'q']);
  bug(6, 'MEDIUM', 'src/lib/flags.mjs:59-65 vs 72-75',
    '`--sub-agents=` (empty `=` value) bypasses the VALUED_FLAGS missing-value guard and silently defaults, while `--sub-agents` is a hard usage error',
    spaceForm === true && eqForm.flags['sub-agents'] === '' && eqForm.pos[0] === 'q');
}

// ============================================================================
// numbers: numericFlag / intOr / clamp against hostile input
// ============================================================================

section('numericFlag: the coercions that MUST be rejected or normalised');
eq('scientific notation is honoured', numericFlag('1e3', { name: '--x', min: 1, max: 2000 }), 1000);
eq('hex notation is honoured', numericFlag('0x10', { name: '--x', min: 1, max: 20 }), 16);
eq('surrounding whitespace is tolerated', numericFlag('  5  ', { name: '--x', min: 1, max: 20 }), 5);
eq('a fraction floors', numericFlag('3.9', { name: '--x', min: 1, max: 20 }), 3);
eq('an absent flag returns the fallback', numericFlag(undefined, { name: '--x', min: 1, max: 20, fallback: 7 }), 7);
eq('an empty value returns the fallback', numericFlag('', { name: '--x', min: 1, max: 20, fallback: 7 }), 7);
ok('"Infinity" is rejected, never passed on',
  await throws(() => numericFlag('Infinity', { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('1e400 (overflows to Infinity) is rejected',
  await throws(() => numericFlag('1e400', { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('"-0" is rejected below a min of 1',
  await throws(() => numericFlag('-0', { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('a negative value is rejected, not clamped',
  await throws(() => numericFlag('-5', { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('0 is rejected below a min of 1',
  await throws(() => numericFlag('0', { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('"7abc" is rejected rather than read as 7',
  await throws(() => numericFlag('7abc', { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
ok('boolean true is rejected with a "needs a numeric value" message',
  await throws(() => numericFlag(true, { name: '--x', min: 1, max: 20 }), 'FLAG_USAGE'));
{
  const e = await caught(() => numericFlag('99', { name: '--sub-agents', min: 1, max: 20 }));
  ok('the range error names the flag and the bounds',
    !!e && /--sub-agents must be between 1 and 20/.test(e.message), e && e.message);
}

section('intOr / clamp: the last line of defence before the wire');
eq('non-numeric falls back', intOr('abc', { min: 1, max: 20, fallback: 10 }), 10);
eq('undefined falls back', intOr(undefined, { min: 1, max: 20, fallback: 10 }), 10);
eq('out of range clamps up', intOr('999', { min: 1, max: 20, fallback: 10 }), 20);
eq('out of range clamps down', intOr('-999', { min: 1, max: 20, fallback: 10 }), 1);
eq('"true" is not read as 1', intOr('true', { min: 1, max: 20, fallback: 10 }), 10);
eq('clamp passes a value already inside the range', clamp(5, 1, 20), 5);
eq('ceilDiv rounds up', ceilDiv(7, 2), 4);

section('intOr / clamp: BUGS ENCONTRADOS');
bug(7, 'LOW', 'src/lib/flags.mjs:121-127',
  'intOr("") returns min (Number("") === 0, then clamps) instead of `fallback` — the docstring promises the fallback. Latent: brave.mjs:275-281 guards "" before calling it, so nothing reaches the wire wrong today',
  intOr('', { min: 1, max: 20, fallback: 10 }) === 1);
bug(8, 'LOW', 'src/lib/flags.mjs:121-127',
  'intOr(null) returns min for the same reason (Number(null) === 0)',
  intOr(null, { min: 1, max: 20, fallback: 10 }) === 1);
bug(9, 'LOW', 'src/lib/flags.mjs:112-115',
  'clamp() JSDoc says "Returns `fallback` for non-finite input instead of NaN", but clamp has no fallback parameter and returns NaN',
  Number.isNaN(clamp(NaN, 1, 20)));

// ============================================================================
// string helpers
// ============================================================================

section('splitList / compactObject / trunc: correct behavior');
eq('splitList trims and drops empties', (splitList(' a , b ,, c ') || []).join('|'), 'a|b|c');
eq('splitList accepts an array', (splitList(['a ', 2]) || []).join('|'), 'a|2');
eq('splitList on a non-string is undefined, not a crash', splitList(true), undefined);
eq('splitList of an empty string is an empty list', (splitList('') || []).length, 0);
ok('compactObject drops undefined', !('a' in compactObject({ a: undefined, b: 1 })));
ok('compactObject drops NaN', !('a' in compactObject({ a: NaN })));
ok('compactObject drops Infinity', !('a' in compactObject({ a: -Infinity })));
ok('compactObject KEEPS null and "" (brave.mjs doFetch drops them at the wire instead)',
  'a' in compactObject({ a: null }) && 'b' in compactObject({ b: '' }));
eq('trunc leaves a short string alone', trunc('abc', 10), 'abc');
eq('trunc adds an ellipsis', trunc('abcdef', 3), 'abc…');
eq('trunc of undefined is an empty string, not a crash', trunc(undefined, 5), '');
eq('maskKey masks a realistic key', maskKey('BSA-super-secret-key-0001'), 'BSA-s…0001');
eq('maskKey on a non-string is <empty>', maskKey(null), '<empty>');

section('string helpers: BUGS ENCONTRADOS');
bug(10, 'MEDIUM', 'src/lib/flags.mjs:149-153',
  'maskKey leaks a short key IN FULL: for length <= 4 the head and tail slices cover the whole string, so maskKey("abcd") === "ab…cd" — every character is printed',
  maskKey('abcd') === 'ab…cd' && maskKey('ab') === 'ab…ab');
bug(11, 'LOW', 'src/lib/flags.mjs:138-141',
  'trunc() drops any falsy non-string: trunc(0, 5) === "" swallows a legitimate 0',
  trunc(0, 5) === '');
{
  const circ = { name: 'x' }; circ.self = circ;
  const threw = await throws(() => flat(circ));
  bug(12, 'LOW', 'src/lib/flags.mjs:143-147',
    'flat() throws on a circular object (JSON.stringify) — it is an error-flattening helper, so the one input it must survive is a weird error object. Currently exported but unused in-tree',
    threw === true);
}

// ============================================================================
// Q1 — can a flag value cross validation and reach the Brave URL as garbage?
// ============================================================================

section('Q1 — what actually reaches the Brave URL (fetch stubbed, no network)');
const brave = await import('../../src/lib/providers/brave.mjs');
const { braveProvider } = brave;
let lastUrl = null;
globalThis.fetch = async (url) => {
  lastUrl = new URL(String(url));
  return {
    ok: true, status: 200,
    headers: new Map(),
    text: async () => JSON.stringify({ web: { results: [] }, query: {} }),
  };
};
const P = (k) => lastUrl.searchParams.get(k);
const run = (args) => braveProvider.search({ query: 'q', ...args }, { key: 'k', version: '8.0.0' });

await run({ max: 'abc', offset: 'zzz' });
ok('a non-numeric --max/--offset never serialises as NaN', !lastUrl.href.includes('NaN'));
ok('and never serialises as "undefined"', !lastUrl.href.includes('undefined'));
eq('a non-numeric --max falls back to the mode default', P('count'), '10');
eq('a non-numeric --offset is dropped entirely', P('offset'), null);
await run({ max: '-5' });   eq('--max=-5 clamps to 1 rather than reaching the wire', P('count'), '1');
await run({ max: '1e9' });  eq('--max=1e9 clamps to Brave\'s ceiling', P('count'), '20');
await run({ max: '0x14' }); eq('--max=0x14 is read as 20', P('count'), '20');
await run({ offset: '-3' }); eq('--offset=-3 clamps to 0', P('offset'), '0');
await run({ max: 'true' });  eq('--max=true does not become 1', P('count'), '10');
await run({ country: '', safesearch: '', searchLang: '' });
eq('an empty --country is dropped at the wire, not sent as country=', P('country'), null);
eq('an empty --safesearch is dropped', P('safesearch'), null);
await run({ freshness: '   ' });
eq('a whitespace-only --freshness is dropped', P('freshness'), null);
await run({});
ok('a bare search sends no stray literals', !/=(NaN|undefined|null|\[object)/.test(decodeURIComponent(lastUrl.href)));

section('Q1: BUGS ENCONTRADOS — validation gaps on the way to the URL');
await run({ freshness: 'not-a-freshness-value' });
bug(13, 'LOW', 'bin/surf-research-skill.mjs:199-209 (no assertEnum) → src/lib/providers/brave.mjs:218',
  '--freshness is the one search flag with ZERO validation: it reaches Brave verbatim and 422s, while --time (the SAME Brave parameter) is enum-checked',
  P('freshness') === 'not-a-freshness-value');
await run({ country: {} });
bug(14, 'MEDIUM', 'src/lib/api/search.mjs:buildArgs (no country check) vs bin/surf-research-skill.mjs:207-209',
  'the LIBRARY path never validates `country` (the CLI does, with /^[A-Za-z]{2}$/), so a non-string reaches the URL as the literal "[object Object]"',
  P('country') === '[object Object]');
await run({ extraSnippets: 'false' });
bug(15, 'LOW', 'src/lib/providers/brave.mjs:299',
  'extraSnippets is compared with === false, so the string "false" (what any flag parser produces) still sends extra_snippets=true',
  P('extra_snippets') === 'true');

// ============================================================================
// Q4 — --brief-file with hostile JSON: usage error or stack trace?
// ============================================================================

section('Q4 — buildBrief survives every hostile --brief-file shape');
const { buildBrief, runAiCommand, reportAiError, AiCliError } = await import('../../src/lib/ai/cli.mjs');
const bf = (name, content) => {
  const p = path.join(HOME, name);
  writeFileSync(p, content);
  return p;
};
for (const [label, body] of [
  ['a JSON array', '["a","b"]'],
  ['JSON null', 'null'],
  ['a JSON number', '42'],
  ['a bare JSON string', '"hello"'],
  ['JSON true', 'true'],
]) {
  const f = bf('bf.json', body);
  const e = await caught(() => buildBrief([], { 'brief-file': f }));
  ok(`${label} is a usage error, not a crash`, !!e && e.code === 'AI_CLI_USAGE', e && `${e.code}: ${e.message}`);
  ok(`${label} says which flag is wrong`, !!e && /--brief-file/.test(e.message), e && e.message);
}
{
  const f = bf('broken.json', '{"question":');
  const e = await caught(() => buildBrief([], { 'brief-file': f }));
  ok('truncated JSON is a usage error naming the file', !!e && e.code === 'AI_CLI_USAGE' && /not valid JSON/.test(e.message));
}
{
  const e = await caught(() => buildBrief([], { 'brief-file': path.join(HOME, 'does-not-exist.json') }));
  ok('a missing --brief-file is a usage error, not an unhandled ENOENT', !!e && e.code === 'AI_CLI_USAGE' && /cannot read/.test(e.message));
}
{
  const e = await caught(() => buildBrief([], { 'brief-file': HOME }));
  ok('a DIRECTORY as --brief-file is a usage error, not an unhandled EISDIR', !!e && e.code === 'AI_CLI_USAGE');
}
{
  const f = bf('nonstr.json', '{"question":123,"task":{"a":1},"goal":[]}');
  const e = await caught(() => buildBrief([], { 'brief-file': f }));
  ok('a non-string "question" degrades to "a question is required", not a type crash',
    !!e && e.code === 'AI_CLI_USAGE' && /a question is required/.test(e.message));
}
{
  const f = bf('proto.json', '{"question":"real q","__proto__":{"polluted":true}}');
  const b = await buildBrief([], { 'brief-file': f });
  eq('a __proto__ key in the brief does not pollute Object.prototype', ({}).polluted, undefined);
  eq('and the question still comes through', b.question, 'real q');
}
{
  const f = bf('good.json', '{"question":"from file","task":"from file","goal":"from file"}');
  const b1 = await buildBrief([], { 'brief-file': f });
  eq('a well-formed brief file supplies the question', b1.question, 'from file');
  const b2 = await buildBrief(['from argv'], { 'brief-file': f, task: 'from flag' });
  eq('a positional question beats the file', b2.question, 'from argv');
  eq('an explicit flag beats the file', b2.task, 'from flag');
  eq('and the file still fills what the flags omitted', b2.goal, 'from file');
}
eq('positionals are joined into one question', (await buildBrief(['how', 'do', 'X'], {})).question, 'how do X');
{
  const e = await caught(() => buildBrief(['   '], {}));
  ok('a whitespace-only question is rejected', !!e && e.code === 'AI_CLI_USAGE');
}
ok('AiCliError is a real Error subclass (so a `catch (e) { e.message }` handler works)',
  new AiCliError('x') instanceof Error);

section('Q4: BUGS ENCONTRADOS');
{
  const e = await caught(() => buildBrief([], { 'brief-file': '' }));
  bug(16, 'LOW', 'src/lib/ai/cli.mjs:33',
    '`--brief-file=` (empty value) is silently ignored — the truthiness check skips the whole block, so the user gets "a question is required" instead of "--brief-file needs a value"',
    !!e && /a question is required/.test(e.message));
}

// ============================================================================
// src/lib/ai/cli.mjs — the --mode aliasing and reportAiError
// ============================================================================

section('--mode aliasing: validation runs BEFORE any network work');
{
  // Every case here must THROW before runSurfAi is reached. `--sub-agents 0`
  // is the tripwire: if a case gets past the mode logic it dies on the number
  // instead of running a real research loop.
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { 'search-mode': 'slwo' }, mode: 'normal' }));
  ok('a bad --search-mode is a FLAG_USAGE error', !!e && e.code === 'FLAG_USAGE' && /--search-mode/.test(e.message));
}
{
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { mode: 'unlimit' }, mode: 'normal' }));
  ok('`surf-search-normal --mode unlimit` is rejected as a contradiction',
    !!e && e.code === 'AI_CLI_USAGE' && /contradicts this command/.test(e.message));
}
{
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { mode: 'fast', 'sub-agents': '0' }, mode: 'normal' }));
  ok('`--mode fast` on a standalone bin is ACCEPTED as --search-mode (it dies on --sub-agents, not on --mode)',
    !!e && e.code === 'FLAG_USAGE' && /--sub-agents/.test(e.message), e && `${e.code}: ${e.message}`);
}
{
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { mode: 'slow', 'search-mode': 'slwo' }, mode: 'normal' }));
  ok('an explicit --search-mode wins over the --mode alias', !!e && /--search-mode/.test(e.message));
}
{
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { 'sub-agents': '99' }, mode: 'normal' }));
  ok('--sub-agents above the ceiling is rejected before any search runs',
    !!e && e.code === 'FLAG_USAGE' && /between 1 and 20/.test(e.message));
}
{
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { 'max-depth': '9' }, mode: 'normal' }));
  ok('--max-depth above 6 is rejected', !!e && e.code === 'FLAG_USAGE');
}
{
  const e = await caught(() => runAiCommand({ pos: ['q'], flags: { 'max-rounds': 'six' }, mode: 'unlimit' }));
  ok('a non-numeric --max-rounds is rejected', !!e && e.code === 'FLAG_USAGE');
}

section('--mode aliasing: BUGS ENCONTRADOS');
{
  // src/lib/ai/cli.mjs:1-6 claims the three entry points "can never drift".
  const viaBin = await caught(() => runAiCommand({ pos: ['q'], flags: { mode: 'fast', 'sub-agents': '0' }, mode: 'normal' }));
  const viaSub = await caught(() => runAiCommand({ pos: ['q'], flags: { mode: 'fast', 'sub-agents': '0' }, mode: undefined }));
  bug(17, 'LOW', 'src/lib/ai/cli.mjs:77-97',
    'the same `--mode fast` is silently re-read as --search-mode on surf-search-normal/-unlimit but is a hard usage error on `surf-research-skill ai` — the three entry points DO drift, against the file header',
    !!viaBin && viaBin.code === 'FLAG_USAGE' && !!viaSub && viaSub.code === 'AI_CLI_USAGE');
}
bug(18, 'MEDIUM', 'src/lib/ai/cli.mjs:122 → src/lib/ai/orchestrator.mjs:90',
  '--budget-ms is the only numeric flag never passed through numericFlag: it goes raw into Number(), so `--budget-ms abc` becomes NaN and is silently discarded instead of being a usage error',
  Number(parseFlags(['--budget-ms', 'abc', 'q']).flags['budget-ms']).toString() === 'NaN');
{
  const unlimitHelp = readFileSync(BIN('surf-search-unlimit.mjs'), 'utf8');
  const orch = readFileSync(path.join(ROOT, 'src', 'lib', 'ai', 'orchestrator.mjs'), 'utf8');
  bug(19, 'LOW', 'bin/surf-search-unlimit.mjs:58 vs src/lib/ai/orchestrator.mjs:156-157',
    'surf-search-unlimit documents `--budget-ms N` but unlimit mode hardcodes budgetMs = Infinity, so the flag has no effect at all there',
    /--budget-ms/.test(unlimitHelp) && /mode === 'unlimit'\s*\n?\s*\? Infinity/.test(orch));
}

section('reportAiError: the exit code an orchestrating agent branches on');
// reportAiError prints to stderr by design; swallow it so the report stays readable.
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;
eq('a FLAG_USAGE error exits 2', reportAiError({ code: 'FLAG_USAGE', message: 'x' }), 2);
eq('an AI_CLI_USAGE error exits 2', reportAiError({ code: 'AI_CLI_USAGE', message: 'x' }), 2);
eq('a NO_TTY error exits 2', reportAiError({ code: 'NO_TTY', message: 'x' }), 2);
eq('a GateError exits with its own code (78)',
  reportAiError({ name: 'GateError', exitCode: 78, message: 'no key' }), 78);
eq('anything else exits 1', reportAiError(new Error('boom')), 1);
eq('a null error still produces an exit code, not a crash', reportAiError(null), 1);
eq('a plain string error is handled', reportAiError('boom'), 1);
process.stderr.write = realStderrWrite;

// ============================================================================
// Q3 / Q5 — command switch, removed verbs, exit codes (child processes)
// ============================================================================

section('Q5 — a removed verb explains itself and exits 2 (never "Unknown command")');
for (const verb of ['extract', 'crawl', 'map', 'research', 'research-start', 'research-poll', 'usage']) {
  const r = cli('surf-research-skill.mjs', [verb, 'x']);
  ok(`'${verb}' exits 2`, r.code === 2, `exit ${r.code}`);
  ok(`'${verb}' says it was removed in v8, not "Unknown command"`,
    /was removed in v8/.test(r.err) && !/Unknown command/.test(r.err), r.err.slice(0, 120));
}
{
  // The gate is skipped for removed verbs on purpose, so the explanation is
  // reachable even with no Brave key at all.
  const r = cli('surf-research-skill.mjs', ['crawl'], { env: { HOME: path.join(HOME, 'nokeys'), USERPROFILE: path.join(HOME, 'nokeys') } });
  ok('a removed verb explains itself even with NO Brave key (exit 2, not 78)', r.code === 2, `exit ${r.code}`);
}

section('Q3 — exit codes that are CORRECT');
{
  const r = cli('surf-research-skill.mjs', ['search', 'q', '--mode', 'slwo']);
  ok('a bad --mode value exits 2', r.code === 2, `exit ${r.code}: ${r.err.slice(0, 120)}`);
}
{
  const r = cli('surf-research-skill.mjs', ['search', 'q', '--mode', 'fast', '--depth', 'basic']);
  ok('--mode together with --depth exits 2', r.code === 2, `exit ${r.code}`);
}
{
  const r = cli('surf-research-skill.mjs', ['search', 'q', '--country', 'zzz']);
  ok('a 3-letter --country exits 2', r.code === 2, `exit ${r.code}`);
}
{
  const r = cli('surf-research-skill.mjs', ['search', 'q', '--safesearch', 'yes']);
  ok('a bad --safesearch exits 2', r.code === 2, `exit ${r.code}`);
}
{
  const r = cli('surf-research-skill.mjs', ['search-parallel', 'q', '--sub-agents', '99']);
  ok('--sub-agents over the ceiling exits 2 before any search runs', r.code === 2, `exit ${r.code}`);
}
{
  // The standalone bins DO wrap parseFlags — this is the behavior the main CLI
  // is measured against in BUG#32 below.
  const r = cli('surf-search-normal.mjs', ['--max', '--json']);
  ok('surf-search-normal maps a parseFlags usage error to exit 2, with no stack trace',
    r.code === 2 && /needs a value/.test(r.err) && !/at parseFlags/.test(r.err), `exit ${r.code}`);
}
{
  const r = cli('surf-research-skill.mjs', ['--help']);
  ok('--help exits 0', r.code === 0, `exit ${r.code}`);
  ok('and prints the exit-code contract it is judged against', /78\s+configuration/.test(r.out));
}
{
  const r = cli('surf-research-skill.mjs', ['--version']);
  ok('--version exits 0', r.code === 0, `exit ${r.code}`);
}

section('Q3 — exit codes: BUGS ENCONTRADOS (the contract is "2 = you typed it wrong")');
{
  // bin/surf-research-skill.mjs:640 calls parseFlags at module top level, OUTSIDE
  // the try/catch at :689 that maps FLAG_USAGE to exit 2. Every FlagError from
  // parsing therefore escapes as an unhandled rejection: Node prints the raw
  // stack (leaking absolute paths) and exits 1. The two standalone bins wrap it
  // correctly (surf-search-normal.mjs:98-103), so only the main CLI is broken.
  const r = cli('surf-research-skill.mjs', ['search', 'q', '--max']);
  const r2 = cli('surf-research-skill.mjs', ['search', 'q', '--sub-agents']);
  bug(32, 'HIGH', 'bin/surf-research-skill.mjs:640 (parseFlags is outside the try at :689-728)',
    'ANY flag usage error caught by parseFlags escapes unhandled: surf-research-skill prints a raw Node stack trace with absolute file paths and exits 1 instead of the documented 2',
    r.code === 1 && /FlagError/.test(r.err) && /at parseFlags/.test(r.err)
      && r2.code === 1 && /at parseFlags/.test(r2.err));
}
{
  const r = cli('surf-research-skill.mjs', ['bogusverb']);
  bug(20, 'MEDIUM', 'bin/surf-research-skill.mjs:718 (die() defaults to code 1)',
    'an unknown command exits 1, but 1 is documented as "the operation ran and failed"; a typo must be 2',
    r.code === 1 && /Unknown command/.test(r.err));
}
{
  const r = cli('surf-research-skill.mjs', ['search']);
  bug(21, 'MEDIUM', 'bin/surf-research-skill.mjs:237',
    '`search` with no query prints a Usage: message and exits 1 instead of 2',
    r.code === 1 && /Usage:/.test(r.err));
}
{
  const r = cli('surf-research-skill.mjs', ['search-parallel']);
  bug(22, 'MEDIUM', 'bin/surf-research-skill.mjs:410',
    '`search-parallel` with no query prints a Usage: message and exits 1 instead of 2',
    r.code === 1 && /Usage:/.test(r.err));
}
{
  const r = cli('surf-research-skill.mjs', ['keys']);
  bug(23, 'MEDIUM', 'bin/surf-research-skill.mjs:582',
    '`keys` with no subcommand prints a Usage: message and exits 1 instead of 2',
    r.code === 1 && /Usage:/.test(r.err));
}
{
  const r = cli('surf-research-skill.mjs', ['search', '--', 'my query']);
  bug(24, 'HIGH', 'bin/surf-research-skill.mjs:237 ← src/lib/flags.mjs:67-78',
    'BUG#1 reaching the CLI: `search -- "my query"` loses the query entirely and reports "Usage:" (exit 1) — the POSIX escape hatch for a query starting with a dash does not work',
    r.code === 1 && /Usage:/.test(r.err));
}

section('Q3 — --queries-file: malformed JSON silently becomes junk QUERIES (quota!)');
{
  // readListFile falls back to newline-splitting on ANY JSON parse error, so a
  // single missing bracket turns the file's syntax into billable searches.
  const f = bf('broken-queries.json', '[\n"alpha query",\n"beta query"\n');
  // Fast, network-free proof: --sub-agents 99 throws AFTER the query list is
  // built. Exit 2 (a flag error) instead of exit 1 ("Usage: ... need queries")
  // proves the malformed file produced a NON-EMPTY query list.
  const fast = cli('surf-research-skill.mjs', ['search-parallel', '--queries-file', f, '--sub-agents', '99']);
  const empty = cli('surf-research-skill.mjs', ['search-parallel', '--sub-agents', '99']);
  ok('control: an EMPTY query list dies with Usage (exit 1) before the flag check', empty.code === 1, `exit ${empty.code}`);
  bug(25, 'HIGH', 'bin/surf-research-skill.mjs:352-365 (readListFile catch-all)',
    'a malformed --queries-file does NOT error: JSON.parse fails and the file is silently re-read as a newline list, so its raw syntax becomes real, billable Brave queries',
    fast.code === 2);

  // The money shot: show the junk queries that would be sent. Only ever
  // resolves brave.invalid, so this costs nothing.
  const eviAll = cli('surf-research-skill.mjs',
    ['search-parallel', '--queries-file', f, '--json', '--sub-agents', '3'], { timeout: 45_000 });
  let sent = [];
  try { sent = JSON.parse(eviAll.out).data.results.map(r => r.query); } catch {}
  bug(26, 'HIGH', 'bin/surf-research-skill.mjs:352-365',
    `evidence — the junk queries actually dispatched: ${JSON.stringify(sent)}`,
    sent.includes('[') && sent.includes('"alpha query",'));
}
{
  const f = bf('obj-queries.json', '{"a":1}');
  const r = cli('surf-research-skill.mjs', ['search-parallel', '--queries-file', f]);
  bug(27, 'LOW', 'bin/surf-research-skill.mjs:358',
    'a --queries-file holding a JSON object (not an array) exits 1; it is a usage error and should be 2',
    r.code === 1 && /must contain a JSON array/.test(r.err));
}
{
  const r = cli('surf-research-skill.mjs', ['search-parallel', '--queries-file', path.join(HOME, 'nope.json')]);
  bug(28, 'LOW', 'bin/surf-research-skill.mjs:355',
    'an unreadable --queries-file exits 1; it is a usage error and should be 2',
    r.code === 1 && /cannot read/.test(r.err));
}

// ============================================================================
// the two standalone bins: argv, --help, --version
// ============================================================================

section('surf-search-normal / -unlimit: argv handling that is CORRECT');
for (const bin of ['surf-search-normal.mjs', 'surf-search-unlimit.mjs']) {
  {
    const r = cli(bin, ['--help']);
    ok(`${bin} --help exits 0`, r.code === 0, `exit ${r.code}`);
    ok(`${bin} --help prints the exit-code contract`, /78 no valid Brave key/.test(r.out));
  }
  {
    const r = cli(bin, ['-h']);
    ok(`${bin} -h exits 0`, r.code === 0, `exit ${r.code}`);
  }
  {
    const r = cli(bin, []);
    ok(`${bin} with no args prints help and exits 2`, r.code === 2 && /Usage:/.test(r.out), `exit ${r.code}`);
  }
  {
    const r = cli(bin, ['--version']);
    ok(`${bin} --version exits 0`, r.code === 0, `exit ${r.code}`);
  }
  {
    const r = cli(bin, ['--sub-agents']);
    ok(`${bin} rejects a valued flag with no value (exit 2)`, r.code === 2 && /needs a value/.test(r.err), `exit ${r.code}`);
  }
  {
    const r = cli(bin, ['--brief-file', path.join(HOME, 'nope.json')]);
    ok(`${bin} reports an unreadable --brief-file as usage (exit 2)`, r.code === 2 && /cannot read/.test(r.err), `exit ${r.code}`);
  }
  {
    const f = bf('adv-array.json', '[1,2]');
    const r = cli(bin, ['--brief-file', f]);
    ok(`${bin} reports a JSON-array --brief-file as usage (exit 2), no stack trace`,
      r.code === 2 && /must contain a JSON object/.test(r.err) && !/at .*\.mjs:\d+/.test(r.err), `exit ${r.code}`);
  }
}

section('the standalone bins: BUGS ENCONTRADOS');
{
  const r = cli('surf-search-normal.mjs', ['--json', '--help']);
  bug(29, 'MEDIUM', 'bin/surf-search-normal.mjs:86-93 · bin/surf-search-unlimit.mjs:93-100',
    '--help/-h/--version are only recognised at argv[0]: `surf-search-normal --json --help` does not print help — and on a machine with no Brave key it exits 78 from the gate before help is ever considered',
    r.code !== 0 && !/Usage:/.test(r.out));
}
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const drift = [];
  for (const [bin, label] of [
    ['surf-research-skill.mjs', 'surf-research-skill'],
    ['surf-search-normal.mjs', 'surf-search-normal'],
    ['surf-search-unlimit.mjs', 'surf-search-unlimit'],
    ['surf.mjs', 'surf'],
    ['surf-plan-skill.mjs', 'surf-plan-skill'],
  ]) {
    const r = cli(bin, ['--version']);
    const reported = (r.out || '').trim();
    if (reported !== pkg.version) drift.push(`${label}=${reported}`);
  }
  bug(30, 'MEDIUM', 'bin/*.mjs `const VERSION` · src/lib/dispatch.mjs:24 · src/lib/ai/orchestrator.mjs:50',
    `every bin hardcodes VERSION and none was bumped: package.json says ${pkg.version} but the CLIs report ${drift.join(', ') || '(none)'} — X-Client-Name on every Brave request is wrong too`,
    drift.length > 0);
}
{
  // The "Search flags" block of surf-research-skill --help promises that they
  // "all actually reach Brave", but runOneSearch only ever forwards
  // query/mode/max, so --domains/--time/--country are inert on the surf-ai path.
  const orch = readFileSync(path.join(ROOT, 'src', 'lib', 'ai', 'orchestrator.mjs'), 'utf8');
  const runOne = orch.slice(orch.indexOf('async function runOneSearch'), orch.indexOf('async function runOneSearch') + 400);
  bug(31, 'MEDIUM', 'src/lib/ai/orchestrator.mjs:515-521 vs bin/surf-research-skill.mjs:112-125',
    'on the surf-ai path only query/mode/max reach Brave — --domains, --exclude, --time, --country, --safesearch, --goggles, --result-filter are accepted and silently dropped, while --help says "all of these now actually reach Brave"',
    !/domains/.test(runOne) && !/country/.test(runOne) && !/freshness/.test(runOne));
}

// ---------------------------------------------------------------- summary ---

section('BUGS ENCONTRADOS — summary');
for (const b of bugRows.filter(b => b.open)) {
  process.stdout.write(`  BUG#${b.id} [${b.severity}] ${b.where}\n         ${b.what}\n`);
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed (correct-behavior assertions)\n`);
process.stdout.write(`${bugsOpen} bugs still present, ${bugsFixed} bugs appear fixed (informational — they never fail this suite)\n`);
if (failures.length) {
  process.stdout.write('\nFAILURES (these DO fail the gate):\n');
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('flags-cli-adversarial-ok\n');
