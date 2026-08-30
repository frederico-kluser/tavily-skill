// Cross-process rate limiter for the Brave Search API.
//
// WHY THIS EXISTS, and why it is not an in-process semaphore:
//
// Brave enforces a 1-second sliding window and counts requests ON ARRIVAL —
// processing time is irrelevant, and a request that fails still consumed its
// slot. Plans differ wildly: a grandfathered "Free" key allows 1 request per
// second, the current paid Search plan allows 50. A 10-way sub-agent fan-out
// against a 1 rps key produces 9 rate-limit errors and one answer.
//
// The sub-agents of surf-research-agent-skill are SEPARATE PROCESSES. An
// in-process limiter would therefore cap each process at N and let ten of them
// issue 10N requests in the same second. So the window ledger lives on disk,
// under a lockfile, shared by every surf process on this machine.
//
// The rate is LEARNED, never guessed: every Brave response carries
//   x-ratelimit-limit:  "1, 2000"
//   x-ratelimit-policy: "1;w=1, 2000;w=2678400"
// and we take the w=1 bucket as the per-second allowance for that key. Until a
// response has been seen we assume the most conservative real-world plan
// (1 rps), because guessing high is what produces the 429 storm.

import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CACHE_DIR } from './state.mjs';
import { sleep } from './flags.mjs';

const LEDGER_FILE = join(CACHE_DIR, 'ratelimit.json');
const LOCK_FILE = join(CACHE_DIR, '.ratelimit.lock');

// What we assume before any response header has taught us otherwise. The
// legacy Free plan is 1 rps; assuming more is how callers get 429s.
const DEFAULT_RPS = Number(process.env.SURF_BRAVE_DEFAULT_RPS) || 1;
// A learned rate older than this is refetched rather than trusted; plans change.
const RATE_TTL_MS = 24 * 60 * 60 * 1000;
// Never wait longer than this for a slot; past it, let the caller through and
// take the 429 rather than hanging inside an agent's bash timeout.
const MAX_WAIT_MS = Number(process.env.SURF_BRAVE_MAX_WAIT_MS) || 15_000;

const DISABLED = process.env.SURF_NO_RATE_LIMIT === '1';

// Brave's window. Also the tolerance for a ledger timestamp that sits AHEAD of
// our clock: see windowTimestamps().
const WINDOW_MS = 1000;
// How long acquireLock will wait for a sibling before giving up on the write.
// The caller caps this further with whatever is left of MAX_WAIT_MS.
const LOCK_TIMEOUT_MS = 3000;
// A lock we cannot attribute to a live local process is only broken once it is
// this old. Liveness beats age whenever we can establish it.
const LOCK_STALE_MS = Number(process.env.SURF_BRAVE_LOCK_STALE_MS) || 30_000;
// Upper bound on the stored window, so a nonsense learned rps cannot grow the
// ledger without limit.
const MAX_RECENT = 4096;

// Who holds the lockfile. host:pid, so a HOME shared over NFS cannot mistake a
// remote pid for a local one.
const LOCK_OWNER = `${hostname()}:${process.pid}`;

/** Keys never touch disk: the ledger is indexed by a short hash of the token. */
function bucketId(key) {
  if (!key) return 'anon';
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

/** Does this pid still exist? EPERM means it does, and belongs to someone else. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

/**
 * May we break the lock that is currently on disk?
 *
 * Only when its owner is provably gone. A lock naming a LIVE local pid belongs
 * to a sibling that is mid-write: stealing it corrupts the ledger for both of
 * us, and the previous code did exactly that on every timeout. When the owner
 * cannot be identified at all (another host, a lock file truncated by a crash)
 * age is the only evidence left, so we wait LOCK_STALE_MS before breaking it.
 */
async function lockIsAbandoned() {
  let owner = '';
  let ageMs = 0;
  try {
    owner = String(await readFile(LOCK_FILE, 'utf8')).trim();
    ageMs = Date.now() - (await stat(LOCK_FILE)).mtimeMs;
  } catch {
    // Already gone, or unreadable: nothing for us to break.
    return false;
  }
  const m = owner.match(/^(?:(.*):)?(\d+)$/);
  const host = m && m[1] ? m[1] : null;
  const pid = m ? Number(m[2]) : NaN;
  if (Number.isFinite(pid) && (host === null || host === hostname())) {
    // A living sibling. Leave the lock alone and proceed unlocked: losing one
    // ledger write costs a little pacing accuracy, breaking a live lock costs
    // the ledger itself.
    return !pidAlive(pid);
  }
  // Unattributable. A negative age (a lockfile stamped in the future by a
  // stepped clock) is NOT evidence of abandonment, so the comparison is
  // one-sided on purpose.
  return ageMs > LOCK_STALE_MS;
}

/**
 * Take the ledger lock. Returns an owner token to hand back to releaseLock(),
 * or null if we could not get it — in which case the caller still reads the
 * ledger and paces itself, it just does not write its own slot back.
 *
 * `timeoutMs` is a CEILING the caller derives from its own MAX_WAIT_MS budget:
 * waiting on a sibling's lock is still waiting, and blocking past that ceiling
 * is precisely the harness-timeout hazard the budget exists to prevent.
 */
async function acquireLock(timeoutMs = LOCK_TIMEOUT_MS) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {
    return null;
  }
  const start = Date.now();
  for (;;) {
    try {
      const fh = await open(LOCK_FILE, 'wx');
      try {
        await fh.writeFile(LOCK_OWNER);
      } finally {
        await fh.close();
      }
      return LOCK_OWNER;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleep(15 + Math.floor(Math.random() * 25));
  }
  if (await lockIsAbandoned()) {
    try { await unlink(LOCK_FILE); } catch {}
    // Breaking a dead owner's lock is only half the job: without this retry the
    // request that paid the whole timeout still writes nothing, so its slot goes
    // unrecorded and the siblings reading the ledger under-count the window.
    try {
      const fh = await open(LOCK_FILE, 'wx');
      try {
        await fh.writeFile(LOCK_OWNER);
      } finally {
        await fh.close();
      }
      return LOCK_OWNER;
    } catch {
      // Someone else got there first; proceed unlocked.
    }
  }
  return null;
}

/** Release only OUR lock: if someone broke it and took it, it is not ours to delete. */
async function releaseLock(token) {
  try {
    const owner = String(await readFile(LOCK_FILE, 'utf8')).trim();
    if (owner && token && owner !== token) return;
  } catch {
    // Unreadable or already gone; fall through and clear whatever is left.
  }
  try { await unlink(LOCK_FILE); } catch {}
}

async function readLedger() {
  try {
    return JSON.parse(await readFile(LEDGER_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function writeLedger(led) {
  const tmp = LEDGER_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(led), { mode: 0o600 });
  await rename(tmp, LEDGER_FILE);
}

/**
 * The timestamps of `raw` that are genuinely inside the current window.
 *
 * A slot is only inside the window if it was taken in the PAST. Anything ahead
 * of `now` came from a clock that moved — an NTP step, a laptop resuming, a
 * HOME shared between machines with different times — and the naive
 * `now - t < 1000` filter accepted all of it, forever: the bucket stayed full,
 * every acquireSlot computed an hour-long wait, tripped the MAX_WAIT_MS escape
 * hatch and returned immediately, so pacing for that key was switched off in
 * silence and every request went out unpaced.
 *
 * So: a small skew (up to one window) is clamped to `now`, which keeps pacing
 * on the conservative side; anything further ahead cannot describe a request
 * made inside the last second and is discarded. Either way the sanitised array
 * is what gets written back, which heals a poisoned ledger on first contact.
 */
function windowTimestamps(raw, now) {
  const kept = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const t = Number(v);
    if (!Number.isFinite(t)) continue;
    if (t > now + WINDOW_MS) continue;
    const ts = t > now ? now : t;
    if (now - ts < WINDOW_MS) kept.push(ts);
  }
  return kept.length > MAX_RECENT ? kept.slice(-MAX_RECENT) : kept;
}

/**
 * Reserve one request slot for `key`, waiting if the window is full.
 *
 * Returns { waitedMs, rps } so the caller can report the pacing it hit.
 * Best-effort by contract: any filesystem problem lets the request through
 * rather than blocking research on a bookkeeping failure.
 */
export async function acquireSlot(key, { signal } = {}) {
  if (DISABLED) return { waitedMs: 0, rps: Infinity, paced: false };
  const id = bucketId(key);
  const startedAt = Date.now();

  for (;;) {
    let wait = 0;
    let rps = DEFAULT_RPS;
    // The lock spin is spent INSIDE the wait budget, not on top of it.
    const budget = Math.max(0, MAX_WAIT_MS - (Date.now() - startedAt));
    const lock = await acquireLock(Math.min(LOCK_TIMEOUT_MS, budget));
    try {
      const led = await readLedger();
      const b = led[id] || {};
      rps = resolveRps(b);
      const now = Date.now();
      // Keep only the timestamps still inside the 1-second window.
      const recent = windowTimestamps(b.recent, now);

      if (recent.length < rps) {
        recent.push(now);
        led[id] = { ...b, recent };
        if (lock) await writeLedger(led);
        return { waitedMs: now - startedAt, rps, paced: now - startedAt > 0 };
      }
      // Full: wait until the oldest timestamp leaves the window, plus jitter so
      // a burst of sibling processes does not re-collide on the same instant.
      const oldest = Math.min(...recent);
      wait = Math.max(5, WINDOW_MS - (now - oldest)) + Math.floor(Math.random() * 60);
      led[id] = { ...b, recent };
      if (lock) await writeLedger(led);
    } catch {
      return { waitedMs: Date.now() - startedAt, rps, paced: false };
    } finally {
      if (lock) await releaseLock(lock);
    }

    if (Date.now() - startedAt + wait > MAX_WAIT_MS) {
      // Give up pacing rather than blowing the harness bash timeout. The caller
      // will likely take a 429, which dispatch retries with its own backoff.
      return { waitedMs: Date.now() - startedAt, rps, paced: true, gaveUp: true };
    }
    if (signal && signal.aborted) return { waitedMs: Date.now() - startedAt, rps, paced: true, aborted: true };
    await sleep(wait);
  }
}

function resolveRps(bucket) {
  if (!bucket || !Number.isFinite(bucket.rps) || bucket.rps < 1) return DEFAULT_RPS;
  const at = Date.parse(bucket.at || '');
  if (!Number.isFinite(at)) return DEFAULT_RPS;
  // Same clock discipline as the window: a stamp far in the future is a broken
  // clock, not a fresh reading, and it must not keep a stale 50 rps alive.
  const age = Date.now() - at;
  if (age > RATE_TTL_MS || age < -RATE_TTL_MS) return DEFAULT_RPS;
  return Math.max(1, Math.floor(bucket.rps));
}

/**
 * Teach the limiter what this key's plan actually allows, from the response
 * headers Brave sends on every 200 AND every 429. Call it after every request.
 *
 * `x-ratelimit-policy: "1;w=1, 2000;w=2678400"` — we want the w=1 bucket.
 * Note 422 responses carry NO rate-limit headers, so absence is normal.
 */
export async function learnFromHeaders(key, headers) {
  if (DISABLED || !headers) return null;
  const policy = getHeader(headers, 'x-ratelimit-policy');
  const limit = getHeader(headers, 'x-ratelimit-limit');
  const remaining = getHeader(headers, 'x-ratelimit-remaining');
  const perSecond = parsePerSecond(policy, limit);
  if (perSecond == null) return null;

  const id = bucketId(key);
  const lock = await acquireLock();
  try {
    const led = await readLedger();
    const b = led[id] || {};
    led[id] = {
      ...b,
      rps: perSecond,
      at: new Date().toISOString(),
      monthlyRemaining: parseMonthlyRemaining(remaining),
    };
    if (lock) await writeLedger(led);
  } catch {
    // Bookkeeping only.
  } finally {
    if (lock) await releaseLock(lock);
  }
  return perSecond;
}

/**
 * Learn from a 429 body. Brave's rate-limit error carries the whole plan
 * inline — `meta: { plan, rate_limit, quota_limit, quota_current }` — which is
 * strictly better than the headers: it names the plan and gives the monthly
 * counter in absolute terms. Free to obtain, since 429s are not billed.
 */
export async function learnFromBody(key, body) {
  if (DISABLED) return null;
  const meta = body && body.error && body.error.meta;
  if (!meta || !Number.isFinite(Number(meta.rate_limit))) return null;
  const rps = Math.max(1, Math.floor(Number(meta.rate_limit)));
  const id = bucketId(key);
  const lock = await acquireLock();
  try {
    const led = await readLedger();
    const b = led[id] || {};
    const used = Number(meta.quota_current);
    const cap = Number(meta.quota_limit);
    led[id] = {
      ...b,
      rps,
      at: new Date().toISOString(),
      plan: typeof meta.plan === 'string' ? meta.plan : b.plan,
      monthlyRemaining: Number.isFinite(used) && Number.isFinite(cap) ? cap - used : b.monthlyRemaining,
    };
    if (lock) await writeLedger(led);
  } catch {
    // Bookkeeping only.
  } finally {
    if (lock) await releaseLock(lock);
  }
  return rps;
}

/** The plan name Brave last reported for this key ('Free', 'Search', ...). */
export async function knownPlan(key) {
  if (DISABLED) return null;
  const led = await readLedger();
  const b = led[bucketId(key)];
  return (b && b.plan) || null;
}

/** How many requests this key has left this month, if we have ever seen it. */
export async function monthlyRemaining(key) {
  if (DISABLED) return null;
  const led = await readLedger();
  const b = led[bucketId(key)];
  return b && Number.isFinite(b.monthlyRemaining) ? b.monthlyRemaining : null;
}

/** The per-second allowance we currently believe this key has. */
export async function knownRps(key) {
  if (DISABLED) return Infinity;
  const led = await readLedger();
  return resolveRps(led[bucketId(key)]);
}

/**
 * Effective simultaneity across all supplied keys. This is what the fan-out
 * planner uses to tell the user that `--sub-agents 10` cannot actually run ten
 * requests at once on a 1 rps plan.
 */
export async function effectiveParallelism(keys) {
  if (DISABLED) return Infinity;
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return DEFAULT_RPS;
  const led = await readLedger();
  let total = 0;
  for (const k of list) total += resolveRps(led[bucketId(k)]);
  return Math.max(1, total);
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

/**
 * "1;w=1, 2000;w=2678400" → 1.  Falls back to the first field of
 * "x-ratelimit-limit: 1, 2000" when the policy header is absent.
 *
 * The monthly window length is account-dependent (31 days observed where the
 * docs say 30), so we match on `w=1` rather than assuming field order.
 */
export function parsePerSecond(policy, limit) {
  if (typeof policy === 'string' && policy.trim()) {
    for (const part of policy.split(',')) {
      const m = part.trim().match(/^(\d+)\s*;\s*w\s*=\s*(\d+)$/);
      if (m && Number(m[2]) === 1) return Math.max(1, Number(m[1]));
    }
  }
  if (typeof limit === 'string' && limit.trim()) {
    const first = Number(limit.split(',')[0].trim());
    if (Number.isFinite(first) && first > 0) return Math.max(1, Math.floor(first));
  }
  return null;
}

/** "0, 118" → 118 (the monthly bucket is the second field). */
export function parseMonthlyRemaining(remaining) {
  if (typeof remaining !== 'string') return null;
  const parts = remaining.split(',').map(s => Number(s.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[1])) return null;
  return parts[1];
}

/**
 * Seconds to wait after a 429. Brave sends no Retry-After; the only signal is
 * x-ratelimit-reset ("1, 183945" — seconds until each window resets).
 */
export function resetDelayMs(headers) {
  const reset = getHeader(headers, 'x-ratelimit-reset');
  if (typeof reset !== 'string') return null;
  const first = Number(reset.split(',')[0].trim());
  if (!Number.isFinite(first) || first < 0) return null;
  // Half fixed, half jitter — synchronized retries are what caused the 429.
  const base = Math.min(first, 5) * 1000;
  return Math.round(base / 2 + Math.random() * (base / 2)) || 250;
}
