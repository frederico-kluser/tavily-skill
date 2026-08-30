// Generic helpers: flag parsing, validation, string ops, key masking.

/** Usage error raised by the parsing/validation helpers below. */
export class FlagError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlagError';
    this.code = 'FLAG_USAGE';
  }
}

// Flags that NEVER take a value. Without this list, `--json "my question"`
// would set flags.json = "my question" and swallow the positional argument —
// the question then looks missing. Only unambiguous switches belong here;
// dual-use flags (--answer, --raw, which accept either `true` or a format
// string) are deliberately left out so their existing behavior is untouched.
const BOOLEAN_FLAGS = new Set([
  'help', 'version',
  'json', 'raw-json', 'quiet', 'ledger',
  'no-cache', 'no-fallback', 'no-budget',
  'confirm-expensive', 'skip-validate',
  'yes', 'all', 'stdin', 'reset',
  'unsafe-show-keys',
]);

// Flags that ALWAYS take a value. A valued flag whose next token is missing or
// is itself a flag used to become boolean `true` silently — which then read as
// `Number(true) === 1` downstream and collapsed a whole fan-out to one worker,
// or ate the question when the next token was the positional. Both directions
// are now a hard usage error instead of a wrong answer.
const VALUED_FLAGS = new Set([
  'max', 'mode', 'depth', 'search-mode',
  'concurrency', 'sub-agents', 'max-rounds', 'max-queries', 'max-depth',
  'budget-ms', 'timeout',
  'topic', 'time', 'start-date', 'end-date',
  'domains', 'exclude', 'country', 'safesearch', 'freshness',
  'search-lang', 'ui-lang', 'result-filter', 'goggles', 'offset',
  'provider', 'ai-model', 'out', 'brief-file', 'queries-file', 'urls-file',
  'task', 'goal', 'insights', 'deliverable',
  'format', 'query', 'key', 'harness',
]);

// Flags that MAY take a value but are also meaningful on their own — `--answer`
// alone means "yes", `--answer basic` picks a format. These are the ONLY names
// outside VALUED_FLAGS still allowed to consume the token after them.
//
// ADDING A FLAG: put its name in exactly one of BOOLEAN_FLAGS, VALUED_FLAGS or
// OPTIONAL_VALUE_FLAGS. A name in none of the three still parses, but as a
// value-less switch — see parseFlags.
const OPTIONAL_VALUE_FLAGS = new Set([
  'answer', 'raw',
]);

/**
 * Parse argv into positionals and flags.
 *
 * Supports `--flag value`, `--flag=value`, and the POSIX `--` end-of-options
 * separator. The `=` form matters: `sub-agents=N` is the documented spelling,
 * and without it `--sub-agents=10` produced the flag key `"sub-agents=10"` AND
 * swallowed the next positional.
 *
 * THE RULE THAT KEEPS THE QUESTION ALIVE: only a name this file KNOWS takes a
 * value (VALUED_FLAGS, OPTIONAL_VALUE_FLAGS) may consume the token after it.
 * An unrecognised `--deep` — a typo, a flag from an older version, a flag some
 * wrapper adds — is recorded as `true` and the next token stays a positional.
 * Before, it ate the question: the CLI then searched something else, or
 * nothing at all, and spent Brave quota doing it, silently.
 */
export function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // POSIX end-of-options. Everything after it is a positional, verbatim —
    // the escape hatch for a query that starts with a dash. `--` used to parse
    // as a flag named "" that swallowed the query behind it.
    if (a === '--') {
      for (let j = i + 1; j < argv.length; j++) pos.push(argv[j]);
      break;
    }

    // A bare `-` is the conventional stdin placeholder, not a flag.
    if (a === '-' || !a.startsWith('-')) { pos.push(a); continue; }

    if (!a.startsWith('--')) {
      // Single dash. surf has no short options beyond the `-h`/`-v` the bins
      // resolve before parsing, so this is a typo (`-q "question"`). Record it
      // as a switch and NEVER consume the next token: falling through to `pos`
      // made `-q "question"` research the literal string "-q question".
      flags[a.slice(1)] = true;
      continue;
    }

    // `--flag=value` — split first, then coerce, so `--json=false` disables
    // rather than enabling a boolean switch. The `=` form must not bypass the
    // missing-value guard below: `--sub-agents=` and `--sub-agents` are the
    // same typo and must cost the same, instead of one silently becoming the
    // default while the other is a hard error.
    const eq = a.indexOf('=');
    if (eq > 2) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      if (VALUED_FLAGS.has(k) && v === '') {
        throw new FlagError(`--${k} needs a value (e.g. --${k}=<value>)`);
      }
      flags[k] = BOOLEAN_FLAGS.has(k) ? (v !== 'false' && v !== '0' && v !== '') : v;
      continue;
    }

    const k = a.slice(2);
    if (BOOLEAN_FLAGS.has(k)) { flags[k] = true; continue; }

    const next = argv[i + 1];
    const missing = next === undefined || next === '--' || next.startsWith('--');
    if (VALUED_FLAGS.has(k)) {
      if (missing) throw new FlagError(`--${k} needs a value (e.g. --${k}=<value>)`);
      flags[k] = next; i++;
      continue;
    }
    if (OPTIONAL_VALUE_FLAGS.has(k)) {
      // Dual-use: take the next token only when it cannot be another option.
      if (missing || next.startsWith('-')) { flags[k] = true; continue; }
      flags[k] = next; i++;
      continue;
    }

    // Unrecognised name: a switch, and the next token is left alone.
    flags[k] = true;
  }
  return { pos, flags };
}

/**
 * Reject a typo instead of silently degrading to a different tier.
 * Returns the value unchanged (or undefined when the flag was not passed).
 */
export function assertEnum(name, value, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true) throw new FlagError(`${name} needs a value (one of: ${allowed.join(', ')})`);
  if (!allowed.includes(value)) {
    throw new FlagError(`${name} must be one of: ${allowed.join(', ')} (got '${value}')`);
  }
  return value;
}

/**
 * Read a numeric flag with NaN/range checking. Returns `fallback` when the
 * flag is absent; throws FlagError when it is present but not a usable number.
 */
export function numericFlag(value, { name, min = 1, max = Number.MAX_SAFE_INTEGER, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) throw new FlagError(`${name} needs a numeric value`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new FlagError(`${name} must be a number (got '${value}')`);
  const floored = Math.floor(n);
  if (floored < min || floored > max) {
    throw new FlagError(`${name} must be between ${min} and ${max} (got ${floored})`);
  }
  return floored;
}

/**
 * Clamp helper. Returns `fallback` for non-finite input instead of NaN.
 * `fallback` may be omitted only when the input is guaranteed finite.
 */
export function clamp(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Coerce to a finite integer inside [min,max], or return `fallback`.
 * This is the guard that stops `--max abc` from serialising as `count=NaN`.
 * The empty string and null are "absent", not zero: Number('') === 0 and
 * Number(null) === 0 would otherwise clamp them to `min` instead of falling
 * back. (Latent callers guard them today; the docstring is the contract.)
 */
export function intOr(value, { min, max, fallback }) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min || floored > max) return clamp(floored, min, max);
  return floored;
}

export function ceilDiv(a, b) {
  return Math.ceil(a / b);
}

export function splitList(s) {
  if (Array.isArray(s)) return s.map(x => String(x).trim()).filter(Boolean);
  return typeof s === 'string' ? s.split(',').map(x => x.trim()).filter(Boolean) : undefined;
}

export function trunc(s, n) {
  if (s === undefined || s === null || s === '') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Flatten an error-ish value to a string without ever throwing — a circular
 * error object is exactly the input this helper exists for. `seen` guards
 * self-referencing message/error/detail chains; JSON.stringify is the last
 * resort and is wrapped because it throws on cycles.
 */
export function flat(v, seen) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const s = seen || new Set();
  if (typeof v === 'object' && s.has(v)) return '[circular]';
  if (typeof v === 'object') s.add(v);
  const nested = flat(v.message, s) || flat(v.error, s) || flat(v.detail, s);
  if (nested) return nested;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Below this length the head+tail slices below overlap or all but cover the
// string, so the "mask" printed the key itself. A mask that does not mask is
// worse than none: the caller believes the value is safe to log or paste.
const MASK_MIN_LEN = 12;

export function maskKey(key) {
  if (!key || typeof key !== 'string') return '<empty>';
  if (key.length < MASK_MIN_LEN) return `…(${key.length} chars)`;
  return key.slice(0, 5) + '…' + key.slice(-4);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Drop undefined keys before they reach a URL. Non-finite numbers are dropped
 * too: `URLSearchParams` happily serialises NaN as the literal string "NaN",
 * which Brave answers with a 422.
 */
export function compactObject(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}
