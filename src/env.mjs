// Key discovery for library mode.
// Priority: levels 1-3 each contribute, and their results are merged + deduped:
//   1. Explicit opts (opts.braveKey / opts.braveKeys / openrouter*)
//   2. process.env  (BRAVE_API_KEYS comma-separated + BRAVE_API_KEY,
//                    OPENROUTER_API_KEYS + OPENROUTER_API_KEY)
//   3. .env file at process.cwd() (lightweight regex parser, no dotenv dep)
// Level 4 — ~/.config/surf/keys.json, the CLI's persistent store — is a
// FALLBACK ONLY: it is consulted per provider just when levels 1-3 produced
// nothing for that provider, and its keys are never merged next to keys the
// caller already supplied. The caller's explicit choice wins; the store only
// speaks when nobody else did.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadState, PROVIDERS } from './lib/state.mjs';
import { progress } from './lib/progress.mjs';

// provider name -> env-var prefix. Kept explicit (rather than uppercasing the
// provider name) so a future provider whose slug differs from its env prefix
// doesn't silently break key discovery.
const ENV_BASE = {
  brave: 'BRAVE',
  openrouter: 'OPENROUTER',
};

// The variable names discovery actually consumes. Parse warnings are limited
// to these: a project .env is full of other people's variables and complaining
// about DATABASE_URL would be noise, not a diagnosis.
const WATCHED = new Set(PROVIDERS.flatMap((p) => {
  const base = ENV_BASE[p] || p.toUpperCase();
  return [`${base}_API_KEY`, `${base}_API_KEYS`];
}));

// The exact names, indexed case-insensitively, so a .env that spells a watched
// variable with the wrong case gets a diagnosis instead of silence. Discovery
// stays case-sensitive (see loadDotenv) — this map exists only for the warning.
const WATCHED_CI = new Map([...WATCHED].map((w) => [w.toLowerCase(), w]));

// Parsed .env content per directory, revalidated against the file's mtime and
// size on every read. A rewritten .env must become visible to a long-lived
// process (D2); the stat gate keeps the cache cheap when nothing changed.
const ENV_FILE_CACHE = new Map(); // dir -> { key: `${mtimeMs}:${size}`|'missing', out }

// A misdiscovered key is invisible at the call site: the caller sees "no valid
// key, exit 78" while the key sits in the file, spelled correctly. Every branch
// below that drops or reshapes a value says so on stderr instead.
function warn(msg) {
  progress.warn(`key discovery: ${msg}`);
}

// ------------------------------------------------------------- .env ------
//
// The parser has to accept what people actually write, because the file that
// holds the key is usually also the file the shell `source`s:
//
//   export BRAVE_API_KEY=bsa-x   the `export` prefix is part of that form
//   BRAVE_API_KEY='bsa-x'       single quotes bind as tightly as double ones
//   BRAVE_API_KEY=abc#def       `#` opens a comment only where it OPENS a
//                               field (start of the value, or after
//                               whitespace); inside a value it is a literal
//   BRAVE_API_KEY=a=b==         only the FIRST `=` separates, so base64
//                               padding survives intact
//
// CRLF and CR line endings, a UTF-8 BOM, blank lines, whitespace around the
// `=` and binary junk are all tolerated: a line that is not an assignment is
// skipped, never fatal.
const ASSIGNMENT = /^[\s\uFEFF]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

/**
 * Take the right-hand side of one assignment and return the value a shell
 * would have produced, plus the one warning (if any) worth printing.
 *
 * @param {string} raw - everything after the first `=`
 * @returns {{value: string, warning: string|null}}
 */
function parseValue(raw) {
  const rest = raw.replace(/^[ \t]+/, '');
  const quote = rest[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    let out = '';
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i];
      // Backslash escapes are a double-quote feature. Inside single quotes a
      // backslash is literal, exactly as in a shell.
      if (c === '\\' && quote === '"' && i + 1 < rest.length) {
        const n = rest[++i];
        out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
        continue;
      }
      // Everything after the closing quote is a trailing comment.
      if (c === quote) return { value: out, warning: null };
      out += c;
    }
    // Unterminated. Fall through to the unquoted branch so a stray quote
    // mangles at most this one value instead of eating the rest of the line.
    const name = quote === '"' ? 'double' : quote === "'" ? 'single' : 'back';
    return {
      value: trimTrailing(stripComment(rest)),
      warning: `the opening ${name} quote is never closed, so the quote character stays in the value`,
    };
  }
  return { value: trimTrailing(stripComment(rest)), warning: null };
}

// A `#` only starts a comment where a field can start: at the beginning of the
// value or after whitespace. `abc#def` is one nine-character value.
function stripComment(s) {
  const m = /(?:^|[ \t])#/.exec(s);
  return m ? s.slice(0, m.index) : s;
}

function trimTrailing(s) {
  return s.replace(/[ \t]+$/, '');
}

async function loadDotenv(dir) {
  const p = path.join(dir, '.env');
  const cached = ENV_FILE_CACHE.get(dir);
  // stat() follows the same path existsSync() used to: absent file and
  // unreadable path both land here without killing readFile's own diagnostics.
  let st = null;
  try { st = await fs.stat(p); } catch { /* absent or unreadable */ }
  const key = st ? `${st.mtimeMs}:${st.size}` : 'missing';
  if (cached && cached.key === key) return cached.out;
  const out = {};
  if (st) {
    try {
      const txt = await fs.readFile(p, 'utf8');
      for (const line of txt.split(/\r\n|\r|\n/)) {
        const m = ASSIGNMENT.exec(line);
        if (!m) continue;                       // blank, comment, or junk
        const [, name, raw] = m;
        const { value, warning } = parseValue(raw);
        out[name] = value;
        if (!WATCHED.has(name)) {
          // A lower- or mixed-case spelling of a watched name is a different
          // variable than the one discovery reads — .env is parsed with shell
          // semantics, where BRAVE_API_KEY and brave_api_key are distinct —
          // but it is exactly the "my key is right there" report when we stay
          // silent. The parse stays case-sensitive; the warning is the fix.
          const canonical = WATCHED_CI.get(name.toLowerCase());
          if (canonical) warn(`${name} in ${p} is not ${canonical}: variable names are case-sensitive, so this value is ignored — use ${canonical}`);
          continue;
        }
        if (warning) warn(`${name} in ${p}: ${warning}`);
        else if (!value) warn(`${name} in ${p} is assigned but empty`);
      }
    } catch (e) {
      // An unreadable .env must never take discovery down — but it must not be
      // invisible either: a chmod-000 or a directory named .env is exactly the
      // "my key is right there" report.
      warn(`${p} could not be read (${e.code || e.message}); continuing with the other sources`);
    }
  }
  ENV_FILE_CACHE.set(dir, { key, out });
  return out;
}

function splitCsv(s) {
  return typeof s === 'string'
    ? s.split(',').map(x => x.trim()).filter(Boolean)
    : [];
}

function arrayify(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
}

function typeOf(v) {
  if (v === null) return 'null';
  return Array.isArray(v) ? 'array' : typeof v;
}

/**
 * Everything that leaves discovery is a trimmed, non-empty string.
 *
 * A number or an object used to survive all the way to the auth header, where
 * it is stringified into `123` or `[object Object]` and the provider answers
 * 401 — a wrong-looking failure for a wrong-typed input.
 */
function sanitizeKeys(list, provider, source) {
  const out = [];
  for (const k of list) {
    if (typeof k !== 'string') {
      warn(`${provider}: dropped a ${typeOf(k)} from ${source} — an API key must be a string`);
      continue;
    }
    const t = k.trim();                 // stray whitespace, CR from a CRLF file
    if (!t) continue;
    if (t.length > 1 && /^["'`]/.test(t) && t[t.length - 1] === t[0]) {
      warn(`${provider}: a key from ${source} begins and ends with ${t[0]} — the quotes are part of the value and the provider will reject it`);
    }
    out.push(t);
  }
  return out;
}

function readFromObject(obj, base) {
  // base = 'BRAVE' | 'OPENROUTER'
  return [
    ...splitCsv(obj[`${base}_API_KEYS`]),
    obj[`${base}_API_KEY`],
  ].filter(Boolean);
}

// opts.braveKey / opts.braveKeys — camelCase option names per provider.
// Mirror of the env level: the plural form splits on commas (BRAVE_API_KEYS
// is CSV, so opts.braveKeys = 'k1,k2' must mean the same two keys), the
// singular form does not (BRAVE_API_KEY holds one key). Non-string entries
// pass through for sanitizeKeys to warn and drop.
function explicitFor(opts, provider) {
  const out = [];
  const single = opts[`${provider}Key`];
  const plural = opts[`${provider}Keys`];
  if (Array.isArray(single)) out.push(...single.filter(Boolean));
  else if (single) out.push(single);
  if (Array.isArray(plural)) out.push(...plural.filter(Boolean));
  else if (typeof plural === 'string') out.push(...splitCsv(plural));
  else if (plural) out.push(plural);
  return out;
}

/**
 * Resolve API keys for every provider using the discovery hierarchy.
 *
 * @param {object} opts
 * @param {string|string[]} [opts.braveKey|opts.braveKeys]
 * @param {string|string[]} [opts.openrouterKey|opts.openrouterKeys]
 * @param {boolean} [opts.skipDotenv=false]
 * @param {boolean} [opts.skipConfigFile=false]
 * @param {string} [opts.cwd=process.cwd()]
 * @returns {Promise<{brave: string[], openrouter: string[]}>}
 */
export async function discoverKeys(opts = {}) {
  const cwd = opts.cwd || process.cwd();

  const explicit = {};
  const env = {};
  const dotenv = {};
  const cfg = {};

  const parsedDotenv = opts.skipDotenv ? {} : await loadDotenv(cwd);

  for (const p of PROVIDERS) {
    const base = ENV_BASE[p] || p.toUpperCase();
    explicit[p] = sanitizeKeys(explicitFor(opts, p), p, `opts.${p}Key(s)`);   // Level 1
    env[p] = sanitizeKeys(readFromObject(process.env, base), p, 'process.env'); // Level 2
    dotenv[p] = opts.skipDotenv                                                // Level 3
      ? []
      : sanitizeKeys(readFromObject(parsedDotenv, base), p, '.env');
    cfg[p] = [];
  }

  // Level 4: ~/.config/surf/keys.json — consulted per provider, and only when
  // levels 1-3 produced nothing for that provider.
  if (!opts.skipConfigFile) {
    const needCfg = (p) => !explicit[p].length && !env[p].length && !dotenv[p].length;
    if (PROVIDERS.some(needCfg)) {
      try {
        const state = await loadState();
        for (const p of PROVIDERS) {
          if (needCfg(p)) cfg[p] = sanitizeKeys((state[p] && state[p].keys) || [], p, 'keys.json');
        }
      } catch {}
    }
  }

  const out = {};
  for (const p of PROVIDERS) {
    const arr = [...new Set([...explicit[p], ...env[p], ...dotenv[p], ...cfg[p]])];
    // Provenance marker for buildInMemoryState: which of these values actually
    // came from keys.json (level 4) in THIS call. Non-enumerable so join,
    // spread, JSON.stringify and array consumers never see it. Burn history
    // (a verdict the CLI already paid for) follows only store-supplied keys;
    // cooldowns and validation verdicts match by value regardless of source.
    Object.defineProperty(arr, '_fromCfg', { value: new Set(cfg[p]), enumerable: false });
    out[p] = arr;
  }
  return out;
}

/**
 * Build an in-memory state object that the dispatch layer can use directly
 * without touching ~/.config/surf/keys.json.
 *
 * Burn, cooldown and validation state IS carried over for keys that came from
 * keys.json. It used to be reset to empty, which meant library callers happily
 * re-used a key the CLI had already proved dead and paid a round-trip to learn
 * it again on every call.
 *
 * The carry-over matches on key VALUE, never on index: discoverKeys merges the
 * sources through a Set, so positions in the merged array have nothing to do
 * with positions in keys.json. Cooldowns and validation verdicts follow the
 * key value wherever it appears. Burn is narrower and provenance-aware: it is
 * the CLI's proof that a key is dead, so it only follows keys that actually
 * came FROM keys.json (level 4) in this call — an identical value supplied via
 * opts/env/.env starts clean, exactly as the caller asked for it fresh.
 */
export async function buildInMemoryState(opts = {}) {
  const discovered = await discoverKeys(opts);

  let stored = null;
  if (!opts.skipConfigFile) {
    try { stored = await loadState(); } catch { stored = null; }
  }

  const state = { schema_version: 1, last_ok_provider: (stored && stored.last_ok_provider) || null, _inMemory: true };
  for (const p of PROVIDERS) {
    const keys = discovered[p] || [];
    const src = stored && stored[p];
    const burned = [];
    const cooldowns = [];
    const validated = [];

    if (src && Array.isArray(src.keys) && src.keys.length) {
      // src.keys can hold the same value twice (a hand-edited keys.json). A
      // value->index Map would keep only the LAST occurrence and silently drop
      // a burn recorded against the first, so each value maps to the LIST of
      // every index it occupies; an entry matching any of them follows the key.
      const oldIndexOf = new Map();
      src.keys.forEach((k, i) => {
        const list = oldIndexOf.get(k);
        if (list) list.push(i);
        else oldIndexOf.set(k, [i]);
      });
      const fromCfg = discovered[p]._fromCfg || null;
      keys.forEach((k, newIdx) => {
        const oldIdxs = oldIndexOf.get(k);
        if (!oldIdxs) return;
        const b = (src.burned || []).find(x => x.index !== undefined && fromCfg && fromCfg.has(k) && oldIdxs.includes(x.index));
        if (b) burned.push({ ...b, index: newIdx });
        const c = (src.cooldowns || []).find(x => x.index !== undefined && oldIdxs.includes(x.index));
        if (c) cooldowns.push({ ...c, index: newIdx });
        const v = (src.validated || []).find(x => x.index !== undefined && oldIdxs.includes(x.index));
        if (v) validated.push({ ...v, index: newIdx });
      });
    }

    state[p] = { keys, current: 0, burned, cooldowns, validated };
  }
  return state;
}
