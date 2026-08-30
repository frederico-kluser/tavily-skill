// State management: ~/.config/surf/keys.json with atomic writes, a
// cross-process lockfile, monthly auto-reset of burned keys, a cached
// validation verdict per key, and one-shot migrations for two pieces of
// history: the legacy ~/.cache/tavily-skill/ directory, and Tavily/Parallel key
// sections left over from v7 (rescued to a sidecar file, never silently
// deleted).
//
// Two invariants this module owes the rest of surf, because the product runs
// up to `--sub-agents` PROCESSES at once and every one of them writes here:
//
//   1. A save never loses another process's write. The lockfile serialises the
//      file replacement, but serialising the replacement is not enough — each
//      writer holds a whole-file snapshot taken at loadState() time, so the
//      last one to finish would erase everybody else. saveStateAtomic()
//      therefore re-reads keys.json inside the lock and, when the file moved
//      under it, three-way merges (snapshot = base, in-memory = mine, disk =
//      theirs) instead of overwriting.
//
//   2. A key is never destroyed silently. Anything we cannot parse is copied
//      aside BEFORE the next write, the copy's path is printed, and the raw
//      bytes are also carried forward inside keys.json under `unreadable`, so
//      the user's only copy of a key survives even if they never read stderr.

import { mkdir, readFile, writeFile, rename, rm, stat, chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sleep } from './flags.mjs';

export const CONFIG_DIR = join(homedir(), '.config', 'surf');
export const KEYS_FILE = join(CONFIG_DIR, 'keys.json');
export const LOCK_FILE = join(CONFIG_DIR, '.keys.lock');
export const CACHE_DIR = join(homedir(), '.cache', 'surf');
export const LEGACY_CACHE_DIR = join(homedir(), '.cache', 'tavily-skill');

// Every provider that owns API keys in keys.json. `openrouter` is NOT a search
// provider — it is the LLM used by surf-ai orchestration (planning, gap
// analysis, synthesis). It lives here so it inherits the whole key machinery
// for free: multi-key rotation, burn-on-auth-failure, monthly un-burn, and
// 429 cooldowns. It is deliberately absent from every `capabilityMap` chain,
// so a search dispatch can never route to it.
export const PROVIDERS = ['brave', 'openrouter'];
// Providers that answer web searches. Brave is the only one, by design — see
// src/lib/providers/index.mjs for why that is enforced structurally.
export const SEARCH_PROVIDERS = ['brave'];
export const SCHEMA_VERSION = 1;

const BURNED_CAP = 50;

// How much of an unreadable keys.json is carried forward inside the new one.
// The sidecar copy is always complete; this inline copy is the belt to its
// braces, so it is capped rather than unbounded.
const UNREADABLE_RAW_CAP = 128 * 1024;

export function blankProvider() {
  return { keys: [], current: 0, burned: [], cooldowns: [], validated: [] };
}

// How long a live key validation is trusted before we re-check. Validating a
// Brave key is free (a q-less request is rejected before it is billed), but it
// still costs a round-trip and a slot in the 1-second rate window, so the
// verdict is cached rather than re-proved on every invocation.
export const VALIDATION_TTL_MS = Number(process.env.SURF_BRAVE_VALIDATION_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

function blankState() {
  const s = { schema_version: SCHEMA_VERSION, last_ok_provider: null };
  for (const p of PROVIDERS) s[p] = blankProvider();
  return s;
}

async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true });
}

// ---------------------------------------------------------------- lock ---
// The lock has to hold between PROCESSES, so it is an O_EXCL file creation —
// the one primitive POSIX gives us that two node processes cannot both win.
// Its content names the holder so a crashed holder can be told apart from a
// slow one: breaking a live holder's lock is exactly the lost update this
// module exists to prevent, and never breaking one deadlocks the fleet.

const LOCK_HOST = hostname();
const lockOwnerTag = () => `${process.pid}@${LOCK_HOST}:${new Date().toISOString()}`;

// A lockfile whose content we do not recognise (an empty file, a hand-written
// placeholder, a half-written owner tag) is only broken once it is this old —
// long enough that we cannot mistake another process's half-finished acquire
// for a corpse, short enough that nobody waits on garbage.
const UNKNOWN_LOCK_GRACE_MS = 750;

// Set while this process owns the lock, so a lockfile left behind by an older
// process that happened to share our pid is recognised as the corpse it is.
let lockHeld = false;

function holderIsAlive(tag) {
  const m = /^(\d+)@([^:]*)/.exec(String(tag || ''));
  if (!m) return null;                       // unrecognised — caller applies the grace period
  if (m[2] && m[2] !== LOCK_HOST) return true; // another machine on a shared FS: never break it
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return lockHeld;  // ours, or a recycled pid's orphan
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';          // alive but not ours to signal
  }
}

async function lockAgeMs() {
  try {
    const st = await stat(LOCK_FILE);
    return Math.max(0, Date.now() - st.mtimeMs);
  } catch {
    return Infinity;
  }
}

/**
 * Take the cross-process lock. Returns once this process owns it.
 * `timeoutMs` bounds how long a *live* holder is waited on before its lock is
 * broken anyway — a hung holder must not wedge every other sub-agent forever.
 */
async function acquireLock(timeoutMs = 10000) {
  await ensureConfigDir();
  const start = Date.now();
  let backoff = 10;
  while (true) {
    try {
      await writeFile(LOCK_FILE, lockOwnerTag(), { flag: 'wx', mode: 0o600 });
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let tag = null;
    try { tag = await readFile(LOCK_FILE, 'utf8'); } catch { tag = null; }
    if (tag === null && !existsSync(LOCK_FILE)) { await sleep(5); continue; } // released under us

    const alive = holderIsAlive(tag);
    const breakIt = alive === false
      || (alive === null && (await lockAgeMs()) > UNKNOWN_LOCK_GRACE_MS)
      || (alive === true && Date.now() - start > timeoutMs);

    if (breakIt) {
      // Only break the lock we just judged: if it changed hands while we were
      // deciding, the new holder is not the one we found dead.
      let still = null;
      try { still = await readFile(LOCK_FILE, 'utf8'); } catch { still = null; }
      if (still === tag) {
        try { await rm(LOCK_FILE, { force: true }); } catch {}
      } else {
        await sleep(5); // it changed hands while we were deciding
      }
      continue; // whoever wins the next O_EXCL create owns it
    }
    await sleep(backoff + Math.floor(Math.random() * 10));
    backoff = Math.min(backoff * 2, 120);
  }
}

async function releaseLock() {
  lockHeld = false;
  try { await rm(LOCK_FILE, { force: true }); } catch {}
}

// Saves inside one process are serialised here as well, so a process never
// contends with (or breaks) its own lock — orchestrator.mjs fires
// saveStateAtomic() without awaiting it in more than one place.
let saveQueue = Promise.resolve();
function queueSave(fn) {
  const run = saveQueue.then(fn, fn);
  saveQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * Age of a stored validation timestamp, measured unilaterally — the same
 * clock discipline ratelimit.mjs has used since its second wave
 * (windowTimestamps / resolveRps): a stamp AHEAD of now is not a verdict
 * from the future, it is a clock that moved (an NTP step, a laptop resume, a
 * hand edit), so it is clamped to `now` (age 0) while it stays within one
 * TTL of ahead — and beyond that it cannot describe a verdict this key
 * earned in this TTL, so it is stale. A stamp that does not parse is stale
 * too. One boundary, shared by the prune in normalizeProvider and the hit
 * test in getValidation: an entry is trusted iff `age < VALIDATION_TTL_MS`.
 */
function validationAge(at, now) {
  const atMs = new Date(at).getTime();
  if (!Number.isFinite(atMs)) return Infinity;
  const age = now - atMs;
  if (age < -VALIDATION_TTL_MS) return Infinity;
  return age < 0 ? 0 : age;
}

function normalizeProvider(p) {
  const obj = p && typeof p === 'object' ? p : {};
  const now = Date.now();
  return {
    keys: Array.isArray(obj.keys) ? obj.keys.filter(k => typeof k === 'string' && k) : [],
    current: Number.isInteger(obj.current) ? obj.current : 0,
    burned: Array.isArray(obj.burned) ? obj.burned.filter(b => b && typeof b === 'object' && Number.isInteger(b.index)) : [],
    // Transient per-key cooldowns (e.g. after a 429). Expired entries are pruned
    // here on every load/save so keys.json stays clean; active ones persist so a
    // rate-limited key isn't hammered first on the next process run.
    cooldowns: Array.isArray(obj.cooldowns)
      ? obj.cooldowns.filter(c => c && typeof c === 'object' && Number.isInteger(c.index)
          && typeof c.until === 'string' && new Date(c.until).getTime() > now)
      : [],
    // Cached live-validation verdicts, so the "is this key valid?" gate does not
    // pay a round-trip on every invocation. Entries whose unilateral age has
    // reached the TTL are pruned here — which is also what makes the TTL
    // authoritative in one place. getValidation MUST use the same boundary
    // (validationAge), or the same verdict is live in memory and dead on disk.
    // NOTE: this object literal is a WHITELIST — a field not listed here is
    // silently dropped by the next saveStateAtomic.
    validated: Array.isArray(obj.validated)
      ? obj.validated.filter(v => v && typeof v === 'object' && Number.isInteger(v.index)
          && typeof v.at === 'string' && validationAge(v.at, now) < VALIDATION_TTL_MS)
      : [],
  };
}

/**
 * When a burned key auto-un-burns. Burns are cleared on the first load of the
 * next calendar month (applyMonthlyReset below), so this is the date to quote
 * to a user staring at a burned key.
 *
 * Lives here rather than in the CLI layer because dispatch and the preflight
 * gate both need it, and the hot path must not import a CLI module.
 *
 * Only a string, a finite number of milliseconds or a Date is a timestamp.
 * `null` in particular is NOT: `new Date(null)` is the epoch, and quoting
 * "1 February 1970" as the day a key comes back is worse than admitting we do
 * not know.
 */
export function nextResetIso(burnedAt) {
  const usable = (typeof burnedAt === 'string' && burnedAt.trim() !== '')
    || (typeof burnedAt === 'number' && Number.isFinite(burnedAt))
    || burnedAt instanceof Date;
  if (!usable) return '—';
  const d = new Date(burnedAt);
  if (Number.isNaN(d.getTime())) return '—';
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

/** The cached validation verdict for one key index, or null. */
export function getValidation(state, provider, index) {
  const p = state && state[provider];
  if (!p || !Array.isArray(p.validated)) return null;
  const hit = p.validated.find(v => v && v.index === index);
  if (!hit) return null;
  // The same unilateral boundary as the normalizeProvider prune, stale the
  // moment the unilateral age reaches the TTL in EITHER direction: an old
  // verdict AND one the clock says is in the future — a `at` ten years ahead
  // must not make the gate trust a revoked key forever (P1, S2). The strict
  // `>=` is what makes the two comparisons agree to the millisecond at
  // exactly TTL.
  if (validationAge(hit.at, Date.now()) >= VALIDATION_TTL_MS) return null;
  return hit;
}

/** Record a live validation verdict for one key index. */
export function setValidation(state, provider, index, { ok, status, reason } = {}) {
  const p = state && state[provider];
  if (!p) return;
  if (!Array.isArray(p.validated)) p.validated = [];
  const entry = { index, at: new Date().toISOString(), ok: !!ok, status: status ?? null, reason: reason ?? null };
  const i = p.validated.findIndex(v => v && v.index === index);
  if (i >= 0) p.validated[i] = entry;
  else p.validated.push(entry);
}

/** Forget a cached verdict (after a burn, or when the key list shifts). */
export function clearValidation(state, provider, index) {
  const p = state && state[provider];
  if (!p || !Array.isArray(p.validated)) return;
  p.validated = index === undefined
    ? []
    : p.validated.filter(v => v && v.index !== index);
}

function applyMonthlyReset(state) {
  const now = new Date();
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth();
  for (const p of PROVIDERS) {
    const sec = state && state[p];
    if (!sec || !Array.isArray(sec.burned)) continue;
    sec.burned = sec.burned.filter(b => {
      const at = new Date(b && b.at);
      // An undated (or unparseable) burn has no month to compare — that is
      // NOT a reset signal (S5). Dropping it would silently un-burn a key the
      // system proved dead; a burn clears by month rollover or by
      // `keys reset` only. It stays, and explainUnusable renders it honestly
      // ("at unknown; auto-resets —").
      if (Number.isNaN(at.getTime())) return true;
      return !(nowY > at.getUTCFullYear() || (nowY === at.getUTCFullYear() && nowM > at.getUTCMonth()));
    });
    // current may now point to a slot that became usable again — leave as-is;
    // nextUsableKeyIndex will surface the lowest usable.
  }
  return state;
}

export async function migrateLegacy() {
  try {
    if (!existsSync(LEGACY_CACHE_DIR)) return;
    if (existsSync(CACHE_DIR)) {
      // Both exist — move unique files from legacy into a sidecar dir.
      const sidecar = join(CACHE_DIR, 'legacy-tavily');
      await mkdir(sidecar, { recursive: true });
      const entries = await readdir(LEGACY_CACHE_DIR);
      for (const f of entries) {
        const src = join(LEGACY_CACHE_DIR, f);
        const dst = join(sidecar, f);
        if (!existsSync(dst)) {
          try { await rename(src, dst); } catch {}
        }
      }
      try { await rm(LEGACY_CACHE_DIR, { recursive: true, force: true }); } catch {}
    } else {
      await rename(LEGACY_CACHE_DIR, CACHE_DIR);
    }
  } catch {
    // Migration is best-effort; never block startup.
  }
}

// ------------------------------------------------- unreadable keys.json ---

/**
 * Copy an unreadable keys.json aside and describe the copy.
 *
 * Content-addressed on purpose: re-reading the same broken file must not spray
 * near-identical backups over ~/.config/surf, and must never claim a copy it
 * did not make. Returns the record that is carried inside the next keys.json,
 * or null when there was nothing to save (or nowhere to save it).
 */
async function quarantineUnreadable(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') return null;
  await ensureConfigDir();
  const day = new Date().toISOString().slice(0, 10);
  const digest = createHash('sha256').update(rawText).digest('hex').slice(0, 8);
  const file = join(CONFIG_DIR, `keys.corrupt-${day}-${digest}.json`);
  const record = (backup) => ({
    at: new Date().toISOString(),
    backup,
    bytes: Buffer.byteLength(rawText, 'utf8'),
    raw: rawText.length > UNREADABLE_RAW_CAP ? rawText.slice(0, UNREADABLE_RAW_CAP) : rawText,
  });
  try {
    await writeFile(file, rawText, { flag: 'wx', mode: 0o600 });
    return record(file);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // Same name means same content hash; verify before claiming the copy.
      try {
        if ((await readFile(file, 'utf8')) === rawText) return record(file);
      } catch {}
    }
  }
  try {
    const alt = join(CONFIG_DIR, `keys.corrupt-${Date.now()}-${process.pid}.json`);
    await writeFile(alt, rawText, { mode: 0o600 });
    return record(alt);
  } catch {
    return null; // could not copy: say so rather than pretend
  }
}

function warnUnreadable(why, record) {
  const tail = record && record.backup
    ? `A verbatim copy was saved to ${record.backup} before anything was rewritten — nothing was destroyed, `
      + `and the original bytes also travel inside keys.json under "unreadable".`
    : `NO copy could be made, so nothing has been rewritten yet — back the file up by hand before running surf again.`;
  process.stderr.write(
    `⚠ surf could not read ${KEYS_FILE} (${why}). ${tail}\n`
    + `  Re-add your key with: surf-research-skill keys add --provider brave <key>\n`,
  );
}

function normalizeUnreadable(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const raw = typeof u.raw === 'string' ? u.raw.slice(0, UNREADABLE_RAW_CAP) : '';
  if (!raw && !u.backup) return null;
  return {
    at: typeof u.at === 'string' ? u.at : new Date().toISOString(),
    backup: typeof u.backup === 'string' ? u.backup : null,
    bytes: Number.isFinite(u.bytes) ? u.bytes : Buffer.byteLength(raw, 'utf8'),
    raw,
  };
}

// Normalize a parsed keys.json to the current schema. Crucially, this
// auto-adds any provider section that's missing from older keys.json files
// (e.g. v2.0.x users upgrading to v2.1.x get a fresh `brave` section without
// any manual migration step).
function normalizeFullState(parsed) {
  const out = {
    schema_version: (parsed && parsed.schema_version) || SCHEMA_VERSION,
    last_ok_provider: parsed && PROVIDERS.includes(parsed.last_ok_provider)
      ? parsed.last_ok_provider
      : null,
  };
  for (const p of PROVIDERS) {
    out[p] = normalizeProvider(parsed && parsed[p]);
  }
  // Not a provider section: the quarantined bytes of a keys.json we could not
  // parse. It survives every save until the user clears it, because it may be
  // the only surviving copy of their key.
  const u = normalizeUnreadable(parsed && parsed.unreadable);
  if (u) out.unreadable = u;
  return out;
}

// ------------------------------------------------------- the 3-way merge ---
// The snapshot rides on the state object under a symbol: invisible to
// JSON.stringify, to Object.keys and to `for...in`, but copied by `{...state}`
// (snapshotForPersist does exactly that), so a spread does not lose the base.
const SNAPSHOT = Symbol.for('surf.state.snapshot');

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

function keyAt(prov, i) {
  return Array.isArray(prov.keys) && Number.isInteger(i) && i >= 0 && i < prov.keys.length ? prov.keys[i] : null;
}

/** Index a provider's burned/cooldowns/validated list by the KEY it points at. */
function byKeyValue(prov, field) {
  const m = new Map();
  for (const e of prov[field] || []) {
    const k = keyAt(prov, e && e.index);
    if (k !== null && !m.has(k)) m.set(k, e);
  }
  return m;
}

function sameEntry(a, b) {
  const strip = (e) => {
    if (!e || typeof e !== 'object') return null;
    const { index, ...rest } = e;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Merge one provider section. Everything is resolved by KEY VALUE, never by
 * index, because a concurrent writer may have shifted every index.
 *
 *   base   what this process read at loadState()
 *   mine   what this process wants to write
 *   theirs what is on disk right now
 *
 * A key I added survives; a key I removed stays removed; a key I never touched
 * is whatever the other writer left. Same rule, entry by entry, for burns,
 * cooldowns and cached verdicts.
 */
function mergeProvider(base, mine, theirs) {
  const b = normalizeProvider(base);
  const m = normalizeProvider(mine);
  const t = normalizeProvider(theirs);

  const removed = new Set(b.keys.filter(k => !m.keys.includes(k)));
  const keys = t.keys.filter(k => !removed.has(k));
  for (const k of m.keys) if (!b.keys.includes(k) && !keys.includes(k)) keys.push(k);

  const out = { keys, current: 0, burned: [], cooldowns: [], validated: [] };
  for (const field of ['burned', 'cooldowns', 'validated']) {
    const mb = byKeyValue(b, field);
    const mm = byKeyValue(m, field);
    const mt = byKeyValue(t, field);
    const list = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const mineE = mm.get(k);
      const pick = sameEntry(mineE, mb.get(k)) ? mt.get(k) : mineE;
      if (pick) list.push({ ...pick, index: i });
    }
    out[field] = list;
  }

  const myCur = keyAt(m, m.current);
  const wanted = myCur !== keyAt(b, b.current) ? myCur : keyAt(t, t.current);
  const ci = wanted === null ? -1 : keys.indexOf(wanted);
  out.current = ci >= 0 ? ci : 0;
  return out;
}

function mergeStates(base, mine, theirs) {
  const out = {
    schema_version: SCHEMA_VERSION,
    last_ok_provider: (mine && mine.last_ok_provider) !== (base && base.last_ok_provider)
      ? (mine && mine.last_ok_provider)
      : (theirs && theirs.last_ok_provider),
  };
  for (const p of PROVIDERS) {
    out[p] = mergeProvider(base && base[p], mine && mine[p], theirs && theirs[p]);
  }
  const u = (mine && mine.unreadable) || (theirs && theirs.unreadable);
  if (u) out.unreadable = u;
  return out;
}

export async function loadState({ skipMonthlyReset = false } = {}) {
  await ensureConfigDir();
  let raw = blankState();
  let diskText = null;
  if (existsSync(KEYS_FILE)) {
    let txt = null;
    try {
      txt = await readFile(KEYS_FILE, 'utf8');
      diskText = txt;
    } catch (e) {
      // Unreadable for a reason we cannot copy around (permissions, a
      // directory where the file should be). Say so; never claim a backup.
      warnUnreadable(e && e.code ? e.code : 'unreadable', null);
      txt = null;
    }
    if (txt !== null) {
      let parsed;
      let why = null;
      try {
        parsed = JSON.parse(txt);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
          why = `it is valid JSON but not an object (${kind})`;
        }
      } catch (e) {
        why = `it is not valid JSON: ${e.message}`;
      }
      if (why) {
        // The copy has to exist BEFORE the next save, not after it.
        const record = await quarantineUnreadable(txt);
        if (txt.trim() !== '') warnUnreadable(why, record);
        raw = blankState();
        if (record) raw.unreadable = record;
      } else {
        const rescued = await rescueLegacyProviderKeys(parsed);
        if (rescued) {
          process.stderr.write(
            `⚠ surf v8 is Brave-only. Your Tavily/Parallel keys were copied to ${rescued} `
            + `before being removed from keys.json — nothing was destroyed.\n`,
          );
        }
        raw = normalizeFullState(parsed);
      }
    }
  } else {
    await saveStateAtomic(raw);
    try { diskText = await readFile(KEYS_FILE, 'utf8'); } catch { diskText = null; }
  }
  if (!skipMonthlyReset) applyMonthlyReset(raw);
  // The base for the three-way merge: what this process believes was on disk
  // when it started, and the exact bytes it saw there.
  raw[SNAPSHOT] = { text: diskText, base: deepClone(raw) };
  return raw;
}

export async function saveStateAtomic(state) {
  await ensureConfigDir();
  return queueSave(async () => {
    const snap = state && state[SNAPSHOT];
    await acquireLock();
    try {
      let diskText = null;
      try { diskText = await readFile(KEYS_FILE, 'utf8'); } catch { diskText = null; }

      let out = state;
      // Only a state that came from loadState() carries a base, and only a
      // file that moved since then needs merging. Everything else writes
      // exactly what the caller built, as it always has.
      if (snap && diskText !== null && diskText !== snap.text) {
        let theirs = null;
        try {
          const p = JSON.parse(diskText);
          if (p && typeof p === 'object' && !Array.isArray(p)) theirs = normalizeFullState(p);
        } catch { theirs = null; }
        if (theirs) {
          out = mergeStates(snap.base, state, theirs);
        } else {
          // Somebody corrupted keys.json after we loaded it. Copy it aside
          // before our write lands on top of it.
          const record = await quarantineUnreadable(diskText);
          out = { ...state };
          if (record) out.unreadable = record;
        }
      }

      const safe = normalizeFullState(out);
      const payload = JSON.stringify(safe, null, 2);
      // A per-process temp name: two writers sharing one ".tmp" path can
      // rename a half-written file into place.
      const tmp = `${KEYS_FILE}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
      try {
        await writeFile(tmp, payload, { mode: 0o600 });
        await rename(tmp, KEYS_FILE);
      } catch (e) {
        try { await rm(tmp, { force: true }); } catch {}
        throw e;
      }
      try { await chmod(KEYS_FILE, 0o600); } catch {}
      // Our snapshot is now the file on disk, so a second save from the same
      // long-lived process does not re-merge against a stale base.
      if (snap) { snap.text = payload; snap.base = deepClone(safe); }
      await sweepStaleTemps();
    } finally {
      await releaseLock();
    }
  });
}

// A process killed between writeFile and rename leaves its temp file behind.
// It is inert, but it should not pile up in the user's config directory.
async function sweepStaleTemps() {
  try {
    const cutoff = Date.now() - 60_000;
    for (const f of await readdir(CONFIG_DIR)) {
      if (!f.startsWith('keys.json.tmp.')) continue;
      const p = join(CONFIG_DIR, f);
      try {
        const st = await stat(p);
        if (st.mtimeMs < cutoff) await rm(p, { force: true });
      } catch {}
    }
  } catch {}
}

export function providerHasUsableKey(state, provider) {
  const p = state && state[provider];
  if (!p || !Array.isArray(p.keys) || !p.keys.length) return false;
  const burnedIdx = new Set((Array.isArray(p.burned) ? p.burned : []).map(b => b && b.index));
  return p.keys.some((_, i) => !burnedIdx.has(i));
}

export function nextUsableKeyIndex(state, provider, skipIndex = -1) {
  const p = state && state[provider];
  if (!p || !Array.isArray(p.keys) || !p.keys.length) return -1;
  const burnedIdx = new Set((Array.isArray(p.burned) ? p.burned : []).map(b => b && b.index));
  const now = Date.now();
  const n = p.keys.length;
  const start = Number.isInteger(p.current) ? Math.max(0, Math.min(p.current, n - 1)) : 0;
  for (let off = 0; off < n; off++) {
    const i = (start + off) % n;
    if (i === skipIndex) continue;
    if (burnedIdx.has(i)) continue;
    if (cooldownActive(p, i, now)) continue;
    return i;
  }
  return -1;
}

// Temporarily sideline a key without burning it (e.g. after a 429). Persisted so
// the next process run doesn't immediately re-hit a rate-limited key. Expired
// entries are pruned in normalizeProvider.
export function setCooldown(state, provider, index, untilMs) {
  const p = state && state[provider];
  if (!p) return;
  const ms = untilMs instanceof Date ? untilMs.getTime() : Number(untilMs);
  // An unparseable deadline is not a cooldown. Refusing it is right; throwing
  // RangeError from inside a 429 handler is not.
  if (!Number.isFinite(ms)) return;
  if (!Array.isArray(p.cooldowns)) p.cooldowns = [];
  const until = new Date(ms).toISOString();
  const existing = p.cooldowns.find(c => c && c.index === index);
  if (existing) existing.until = until;
  else p.cooldowns.push({ index, until });
}

export function cooldownActive(providerState, index, now = Date.now()) {
  if (!providerState || !Array.isArray(providerState.cooldowns)) return false;
  const c = providerState.cooldowns.find(x => x && x.index === index);
  if (!c) return false;
  const until = new Date(c.until).getTime();
  return Number.isFinite(until) && until > now;
}

export function markBurned(state, provider, index, reason) {
  const p = state && state[provider];
  if (!p) return;
  // A burn overrides any cached "valid" verdict: proof from the live API beats
  // a week-old cache entry.
  clearValidation(state, provider, index);
  if (!Array.isArray(p.burned)) p.burned = [];
  if (p.burned.some(b => b && b.index === index)) return;
  p.burned.push({ index, at: new Date().toISOString(), reason: String(reason || 'unknown') });
  while (p.burned.length > BURNED_CAP) p.burned.shift();
}

export function clearBurned(state, provider) {
  if (!state || typeof state !== 'object') return;
  for (const p of provider ? [provider] : PROVIDERS) {
    const sec = state[p];
    // A provider section that isn't there has no burns to clear. Saying so is
    // the whole job; crashing on `keys reset` because openrouter was never
    // configured is not.
    if (sec && typeof sec === 'object') sec.burned = [];
  }
}

/**
 * Why a provider cannot serve a request right now, in words a user can act on.
 *
 * The old NoProviderAvailable message always said "keys add", even when the
 * user had a perfectly good key that had merely been burned — for which the fix
 * is `keys reset`, not another key. One function, so every throw site agrees.
 */
export function explainUnusable(state, provider) {
  const p = state && state[provider];
  if (!p || !Array.isArray(p.keys) || !p.keys.length) {
    return { reason: 'no key configured', fix: `surf-research-skill keys add --provider ${provider} <key>` };
  }
  const burnedList = Array.isArray(p.burned) ? p.burned : [];
  const burnedIdx = new Set(burnedList.map(b => b && b.index));
  const usable = p.keys.map((_, i) => i).filter(i => !burnedIdx.has(i));
  if (!usable.length) {
    const b = burnedList[0] || {};
    return {
      reason: `all ${p.keys.length} key(s) burned (${b.reason || 'auth'}, at ${b.at || 'unknown'}; auto-resets ${nextResetIso(b.at)})`,
      fix: `surf-research-skill keys reset --provider ${provider}`,
    };
  }
  const now = Date.now();
  const cooling = usable.filter(i => cooldownActive(p, i, now));
  if (cooling.length === usable.length) {
    const c = (p.cooldowns || []).find(x => x && x.index === cooling[0]);
    return {
      reason: `all usable key(s) are cooling down after a rate limit until ${c ? c.until : 'shortly'}`,
      fix: 'wait for the cooldown to expire, or add another key to widen the rate budget',
    };
  }
  return null;
}

/** Union the key lists of two legacy-rescue payloads, newest fields winning. */
function mergeLegacyPayloads(prev, next) {
  const out = { ...prev };
  for (const [name, sec] of Object.entries(next)) {
    const before = prev[name] && Array.isArray(prev[name].keys) ? prev[name].keys : [];
    const now = Array.isArray(sec.keys) ? sec.keys : [];
    const keys = [...before];
    for (const k of now) if (!keys.includes(k)) keys.push(k);
    out[name] = { ...(prev[name] || {}), ...sec, keys };
  }
  return out;
}

/**
 * One-shot rescue of keys belonging to providers this version no longer
 * supports. v8.0.0 dropped Tavily and Parallel; silently deleting paid keys
 * from a user's config would be indefensible, so they are copied out first.
 *
 * The rescue is per DAY, but a second rescue on the same day is a real event —
 * a restored backup, two machines syncing ~/.config/surf — and the keys in it
 * are different keys. It merges into the day's file instead of skipping, so
 * the path this returns (and loadState prints) is always a file that really
 * does contain the keys about to leave keys.json.
 */
async function rescueLegacyProviderKeys(parsed) {
  const legacy = {};
  for (const name of ['tavily', 'parallel']) {
    const sec = parsed && parsed[name];
    if (sec && Array.isArray(sec.keys) && sec.keys.some(k => typeof k === 'string' && k)) legacy[name] = sec;
  }
  if (!Object.keys(legacy).length) return null;

  const file = join(CONFIG_DIR, `keys.legacy-${new Date().toISOString().slice(0, 10)}.json`);
  let existingTxt = null;
  if (existsSync(file)) {
    try { existingTxt = await readFile(file, 'utf8'); } catch { existingTxt = null; }
  }
  let merged = legacy;
  if (existingTxt !== null) {
    let prev = null;
    try { prev = JSON.parse(existingTxt); } catch { prev = null; }
    if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
      merged = mergeLegacyPayloads(prev, legacy);
    } else {
      // The sidecar is itself unreadable — never overwrite it, and never
      // report a path that does not hold these keys.
      try {
        const alt = join(CONFIG_DIR, `keys.legacy-${Date.now()}-${process.pid}.json`);
        await writeFile(alt, JSON.stringify(legacy, null, 2), { mode: 0o600 });
        return alt;
      } catch {
        return null;
      }
    }
  }
  const payload = JSON.stringify(merged, null, 2);
  if (existingTxt === payload) return file; // already byte-identical on disk
  try {
    await writeFile(file, payload, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

export async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}
