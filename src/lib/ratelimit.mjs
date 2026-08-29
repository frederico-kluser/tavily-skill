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

import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

/** Keys never touch disk: the ledger is indexed by a short hash of the token. */
function bucketId(key) {
  if (!key) return 'anon';
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

async function acquireLock(timeoutMs = 3000) {
  await mkdir(CACHE_DIR, { recursive: true });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fh = await open(LOCK_FILE, 'wx');
      await fh.close();
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
  // Stale lock (a crashed process): break it rather than deadlocking the fleet.
  try { await unlink(LOCK_FILE); } catch {}
  return false;
}

async function releaseLock() {
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
    const locked = await acquireLock();
    try {
      const led = await readLedger();
      const b = led[id] || {};
      rps = resolveRps(b);
      const now = Date.now();
      // Keep only the timestamps still inside the 1-second window.
      const recent = (Array.isArray(b.recent) ? b.recent : []).filter(t => now - t < 1000);

      if (recent.length < rps) {
        recent.push(now);
        led[id] = { ...b, recent };
        if (locked) await writeLedger(led);
        return { waitedMs: now - startedAt, rps, paced: now - startedAt > 0 };
      }
      // Full: wait until the oldest timestamp leaves the window, plus jitter so
      // a burst of sibling processes does not re-collide on the same instant.
      const oldest = Math.min(...recent);
      wait = Math.max(5, 1000 - (now - oldest)) + Math.floor(Math.random() * 60);
      led[id] = { ...b, recent };
      if (locked) await writeLedger(led);
    } catch {
      return { waitedMs: Date.now() - startedAt, rps, paced: false };
    } finally {
      if (locked) await releaseLock();
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
  if (!Number.isFinite(at) || Date.now() - at > RATE_TTL_MS) return DEFAULT_RPS;
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
  const locked = await acquireLock();
  try {
    const led = await readLedger();
    const b = led[id] || {};
    led[id] = {
      ...b,
      rps: perSecond,
      at: new Date().toISOString(),
      monthlyRemaining: parseMonthlyRemaining(remaining),
    };
    if (locked) await writeLedger(led);
  } catch {
    // Bookkeeping only.
  } finally {
    if (locked) await releaseLock();
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
  const locked = await acquireLock();
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
    if (locked) await writeLedger(led);
  } catch {
    // Bookkeeping only.
  } finally {
    if (locked) await releaseLock();
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
