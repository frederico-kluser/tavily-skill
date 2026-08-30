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

// What acquireSlot reports as rps when pacing is disabled (SURF_NO_RATE_LIMIT=1).
// The honest answer is Infinity, but Infinity collapses to null under
// JSON.stringify, so any --json envelope or ledger line made the consumer read
// "unknown" where the truth was "no limit at all". MAX_SAFE_INTEGER is a
// finite number — it round-trips through JSON, prints as a number, sorts as
// one — and no real plan allowance can be mistaken for it.
const UNLIMITED_RPS = Number.MAX_SAFE_INTEGER;

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

// THE MONTHLY QUOTA IS NOT A BACKOFF.
//
// Brave's two buckets fail differently. The per-second bucket refills in a
// second, so "wait and retry" is the right answer. The monthly bucket refills
// once a month, and NOTHING this process can wait for will bring it back —
// retrying is guaranteed to fail, and on this account the second key is the one
// that still has quota, so time spent sleeping on the empty key is time stolen
// from the key that works.
//
// So the two facts are carried on two different channels:
//
//   resetDelayMs()  — the SLEEP channel. Its only consumer is dispatch.mjs:298
//                     (`await sleep(e.retryAfterMs)`), which sleeps the raw
//                     number, twice, INSIDE the retry loop and OUTSIDE the
//                     harness-budget guard (that guard runs once per key, before
//                     the attempts). The default budget for an unrecognised
//                     harness is 30s. Handing that channel the real monthly
//                     reset — 183945s, observed — would not sideline the key, it
//                     would freeze surf for two days. So it stays CLAMPED.
//
//   the ledger      — the EXPIRY channel. `quotaResetAt` is an absolute instant
//                     that survives the process and expires by itself, which is
//                     what "this key is done until the month turns over"
//                     actually means.
//
// Ceiling for the sleep channel on a quota 429. Deliberately the same 5s that
// the per-second path already allows, so recognising a quota 429 adds no new
// worst case to a budget that is only 30s by default — it merely stops a
// month-long outage being answered with the 1-second bucket's reset.
const QUOTA_BACKOFF_MS = Number(process.env.SURF_BRAVE_QUOTA_BACKOFF_MS) || 5_000;
// The per-second path's own ceiling, unchanged.
const RATE_BACKOFF_MS = 5_000;
// Longest a key may be held as quota-exhausted. The observed monthly window is
// 31 days (`w=2678400`); a header or a stepped clock claiming more than that
// does not buy a longer hold, because the hold has to expire on its own.
const MAX_QUOTA_HOLD_MS = 2_678_400 * 1000;

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
  if (DISABLED) return { waitedMs: 0, rps: UNLIMITED_RPS, paced: false };
  const id = bucketId(key);
  const startedAt = Date.now();
  // `paced` means "we actually waited for a slot", never "the lock and the
  // ledger read took a millisecond". The old `now - startedAt > 0` was true
  // on every lock acquisition — one slow stat() reported pacing that never
  // happened, which brave.mjs then had to paper over with a 250ms threshold.
  // It is flipped only right before a real sleep, so a slot granted on the
  // first read reports paced: false no matter how long the lock took.
  let paced = false;

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
        return { waitedMs: now - startedAt, rps, paced };
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
    paced = true; // a real sleep for a slot is about to happen
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
 *
 * ABSENCE IS NOT ZERO. A 200 carries the policy but does not always carry
 * `x-ratelimit-remaining`, and this function used to write the parse of that
 * missing header — null — straight over the monthly counter. One ordinary 200
 * therefore erased the exact figure a 429 body had just taught us, which on an
 * account with ~117 searches left for the month is the difference between
 * knowing what is left and flying blind. The counter is only overwritten by a
 * response that actually reported one.
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
      // `?? b.monthlyRemaining`: a response that reported nothing teaches
      // nothing. A response that reported a number — including 0 — still wins.
      monthlyRemaining: parseMonthlyRemaining(remaining) ?? b.monthlyRemaining,
      quotaResetAt: nextQuotaResetAt(b, strictMonthlyRemaining(remaining), getHeader(headers, 'x-ratelimit-reset')),
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
  if (!meta) return null;
  const rpsRaw = Number(meta.rate_limit);
  const rps = Number.isFinite(rpsRaw) ? Math.max(1, Math.floor(rpsRaw)) : null;
  const id = bucketId(key);
  const lock = await acquireLock();
  try {
    const led = await readLedger();
    const b = led[id] || {};
    const used = Number(meta.quota_current);
    const cap = Number(meta.quota_limit);
    const left = Number.isFinite(used) && Number.isFinite(cap) ? cap - used : null;
    // A body whose meta is missing rate_limit still names the plan and the
    // quota counters, and both are worth keeping: the per-second allowance is
    // the only fact that needs rate_limit. Only `rps`/`at` are gated on it.
    if (rps == null && left == null && typeof meta.plan !== 'string') return null;
    led[id] = {
      ...b,
      ...(rps == null ? {} : { rps, at: new Date().toISOString() }),
      plan: typeof meta.plan === 'string' ? meta.plan : b.plan,
      // A counter that went over its cap must never display as a negative
      // number of requests left; the month is spent, so it reads 0.
      monthlyRemaining: left == null ? b.monthlyRemaining : Math.max(0, left),
      // The body names the counters but never says WHEN the month turns over,
      // so it can lift an exhaustion mark (quota is back) but never invent one.
      // It does not need to: brave.mjs learns from the same 429's headers first,
      // and those carry x-ratelimit-reset.
      quotaResetAt: nextQuotaResetAt(b, left, null),
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
  // Clamp at read as well as at write: a ledger written by an older build (or
  // a hand edit) can hold a negative value from an over-spent counter, and a
  // display of "-5 left" would invent requests the month does not have.
  return b && Number.isFinite(b.monthlyRemaining) ? Math.max(0, b.monthlyRemaining) : null;
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
 *
 * Counted per BUCKET, not per entry. The ledger has always been indexed by a
 * hash of the token, so one key listed twice — the same string in keys.json and
 * in BRAVE_API_KEY, the commonest way a ring is built — is ONE budget. Summing
 * the list instead advertised double: the planner then promised two simultaneous
 * sub-agents against a 1 rps allowance and collected a 429 for the second.
 *
 * A key whose monthly quota is spent contributes nothing, because it can serve
 * nothing until the month turns over. That is a fact with an expiry date, not a
 * verdict: see nextQuotaResetAt().
 */
export async function effectiveParallelism(keys) {
  if (DISABLED) return Infinity;
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return DEFAULT_RPS;
  const led = await readLedger();
  const now = Date.now();
  let total = 0;
  for (const id of new Set(list.map(bucketId))) {
    if (quotaExhausted(led[id], now)) continue;
    total += resolveRps(led[id]);
  }
  return Math.max(1, total);
}

/**
 * Is this bucket's monthly quota spent RIGHT NOW?
 *
 * The whole mechanism is one absolute instant on disk, and that is the point.
 * A boolean "exhausted" flag would need someone to come back and clear it; an
 * instant clears itself the moment it passes — no next run, no operator, no
 * file to delete. It is the same discipline that stopped a 429 from calling
 * markBurned (which never expires): a transient signal may buy a pause, never
 * an irreversible decision.
 */
function quotaExhausted(bucket, now = Date.now()) {
  if (!bucket) return false;
  const until = Date.parse(bucket.quotaResetAt || '');
  if (!Number.isFinite(until)) return false;
  // A hold reaching further out than one monthly window describes a clock that
  // moved, not a quota Brave reported, and it must not outlive the window it
  // claims. One-sided on purpose, exactly like windowTimestamps().
  if (until - now > MAX_QUOTA_HOLD_MS) return false;
  return until > now;
}

/**
 * The `quotaResetAt` to store, given what this response reported.
 *
 * Three states, and the difference between them is the whole fix:
 *   left == null → the response said nothing about the month; keep what we knew.
 *   left  >  0   → quota is back; the mark is dropped and the key is live again.
 *   left <=  0   → the month is gone; hold the key until Brave's stated reset.
 */
function nextQuotaResetAt(bucket, left, resetHeader) {
  const prev = (bucket && bucket.quotaResetAt) || undefined;
  if (left == null) return prev;
  if (left > 0) return undefined;
  return parseQuotaResetAt(resetHeader) || prev;
}

/** "1, 183945" → the ISO instant the MONTHLY window resets, clamped to a month. */
function parseQuotaResetAt(reset) {
  if (typeof reset !== 'string') return null;
  const parts = reset.split(',');
  if (parts.length < 2) return null;
  const raw = parts[1].trim();
  if (!/^\d+$/.test(raw)) return null;
  const secs = Number(raw);
  if (!(secs > 0)) return null;
  return new Date(Date.now() + Math.min(secs * 1000, MAX_QUOTA_HOLD_MS)).toISOString();
}

/**
 * The monthly field of `x-ratelimit-remaining`, parsed STRICTLY. This is the
 * value that decides whether a key gets stood down for a month, so a field
 * that is not plainly an integer is "unknown", never "your month is gone".
 * (The display counter parses by the same rule — see parseMonthlyRemaining().)
 */
function strictMonthlyRemaining(remaining) {
  if (typeof remaining !== 'string') return null;
  const parts = remaining.split(',');
  if (parts.length < 2) return null;
  const raw = parts[1].trim();
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
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
 * docs say 30), so we match on `w=1` rather than assuming field order. When a
 * policy lists MORE than one w=1 bucket, the SMALLEST one wins: two
 * contradictory per-second allowances make the smaller the only safe guess,
 * and the first-listed one is just whatever order the server chose.
 */
export function parsePerSecond(policy, limit) {
  if (typeof policy === 'string' && policy.trim()) {
    let min = null;
    for (const part of policy.split(',')) {
      const m = part.trim().match(/^(\d+)\s*;\s*w\s*=\s*(\d+)$/);
      if (m && Number(m[2]) === 1) {
        const v = Math.max(1, Number(m[1]));
        if (min === null || v < min) min = v;
      }
    }
    if (min !== null) return min;
  }
  if (typeof limit === 'string' && limit.trim()) {
    const first = Number(limit.split(',')[0].trim());
    if (Number.isFinite(first) && first > 0) return Math.max(1, Math.floor(first));
  }
  return null;
}

/** "0, 118" → 118 (the monthly bucket is the second field). */
export function parseMonthlyRemaining(remaining) {
  // The display counter parses by the same strict rule as the exhaustion
  // decision (strictMonthlyRemaining), not by Number(): Number("") is 0, so
  // a header with a dangling comma used to report "0 left this month" where
  // the header actually said nothing about the month. Unknown stays unknown.
  const strict = strictMonthlyRemaining(remaining);
  if (strict == null) return null;
  // A negative value means the counter went over its cap; the month is spent,
  // so the display reads 0, never a negative ("0, -5" used to pass through).
  return Math.max(0, strict);
}

/**
 * Milliseconds to wait after a 429. Brave sends no Retry-After; the only signal
 * is x-ratelimit-reset ("1, 183945" — seconds until each window resets).
 *
 * WHICH WINDOW ACTUALLY RAN OUT decides which field to read. The companion
 * header says so outright:
 *
 *   x-ratelimit-remaining: 0, 118   the second is spent, the month is fine
 *                                   → field 1 ("1"): wait a second, retry, win.
 *   x-ratelimit-remaining: 0, 0     the MONTH is spent
 *                                   → field 1 is a lie of omission. That window
 *                                     really does reopen in one second, and it
 *                                     reopens onto an empty quota, so the key
 *                                     left the backoff after ~600ms and went
 *                                     back to collecting 429s for the rest of
 *                                     the month. Field 2 is the honest number.
 *
 * Reading field 2 is not the same as SLEEPING field 2, and the difference is
 * deliberate: see QUOTA_BACKOFF_MS. 183945s handed to `await sleep()` is not a
 * cooldown, it is a two-day hang, and on this account it would also strand the
 * second key — the one that still has quota — behind the dead one. The month is
 * therefore remembered in the ledger (quotaResetAt), where it costs nobody any
 * wall-clock time, and only a bounded, jittered wait is handed to the caller.
 */
export function resetDelayMs(headers) {
  const reset = getHeader(headers, 'x-ratelimit-reset');
  if (typeof reset !== 'string') return null;
  const first = Number(reset.split(',')[0].trim());
  if (!Number.isFinite(first) || first < 0) return null;
  const left = strictMonthlyRemaining(getHeader(headers, 'x-ratelimit-remaining'));
  const monthGone = left != null && left <= 0;
  const seconds = monthGone ? monthlyResetSeconds(reset, first) : first;
  // Half fixed, half jitter — synchronized retries are what caused the 429.
  const base = Math.min(seconds * 1000, monthGone ? QUOTA_BACKOFF_MS : RATE_BACKOFF_MS);
  return Math.round(base / 2 + Math.random() * (base / 2)) || 250;
}

/** Field 2 of "1, 183945" — seconds to the monthly reset; field 1 if absent. */
function monthlyResetSeconds(reset, fallback) {
  const parts = reset.split(',');
  if (parts.length < 2) return fallback;
  const raw = parts[1].trim();
  return /^\d+$/.test(raw) ? Number(raw) : fallback;
}
