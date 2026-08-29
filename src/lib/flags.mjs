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

/**
 * Parse argv into positionals and flags.
 *
 * Supports both `--flag value` and `--flag=value`. The `=` form matters:
 * `sub-agents=N` is the documented spelling, and without it `--sub-agents=10`
 * produced the flag key `"sub-agents=10"` AND swallowed the next positional.
 */
export function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }

    // `--flag=value` — split first, then coerce, so `--json=false` disables
    // rather than enabling a boolean switch.
    const eq = a.indexOf('=');
    if (eq > 2) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      flags[k] = BOOLEAN_FLAGS.has(k) ? (v !== 'false' && v !== '0' && v !== '') : v;
      continue;
    }

    const k = a.slice(2);
    if (BOOLEAN_FLAGS.has(k)) { flags[k] = true; continue; }

    const next = argv[i + 1];
    const missing = next === undefined || next.startsWith('--');
    if (VALUED_FLAGS.has(k)) {
      if (missing) throw new FlagError(`--${k} needs a value (e.g. --${k}=<value>)`);
      flags[k] = next; i++;
      continue;
    }
    if (missing) flags[k] = true;
    else { flags[k] = next; i++; }
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

/** Clamp helper. Returns `fallback` for non-finite input instead of NaN. */
export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/**
 * Coerce to a finite integer inside [min,max], or return `fallback`.
 * This is the guard that stops `--max abc` from serialising as `count=NaN`.
 */
export function intOr(value, { min, max, fallback }) {
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
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function flat(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return flat(v.message) || flat(v.error) || flat(v.detail) || JSON.stringify(v);
}

export function maskKey(key) {
  if (!key || typeof key !== 'string') return '<empty>';
  if (key.length <= 9) return key.slice(0, 2) + '…' + key.slice(-2);
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
