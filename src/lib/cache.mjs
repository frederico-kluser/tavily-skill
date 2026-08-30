// Response cache keyed by (provider, endpoint, body).

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CACHE_DIR, ensureCacheDir } from './state.mjs';

export const TTL_MS = (Number(process.env.SURF_CACHE_TTL || process.env.TAVILY_CACHE_TTL) || 21600) * 1000;

// What cacheKey() emits, and therefore the ONLY thing cacheClear() is allowed
// to delete: 24 hex characters. ~/.cache/surf is shared with state that is not
// a cached response — see cacheClear().
const ENTRY_RE = /^[0-9a-f]{24}\.json$/;

// Canonical render of `body` for the cache key: object keys sorted
// recursively, so the same search assembled by two call sites with the
// properties in a different insertion order hashes to the same key (an
// unordered object has no order). Array order is preserved — a list is an
// ordered value, and reversing it changes the request.
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalJson(value[k]);
    return out;
  }
  return value;
}

export function cacheKey(provider, endpoint, body) {
  return createHash('sha256')
    .update(`${provider}:${endpoint}:${JSON.stringify(canonicalJson(body || {}))}`)
    .digest('hex')
    .slice(0, 24);
}

export async function cacheGet(key) {
  const f = join(CACHE_DIR, key + '.json');
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(await readFile(f, 'utf8'));
    // No usable timestamp means we cannot age the entry, and `NaN > TTL_MS` is
    // false — which is how a truncated or hand-edited file became immortal.
    // Unaged is a MISS, not a hit.
    if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.ts)) return null;
    const age = Date.now() - raw.ts;
    // A stamp far in the future (a stepped clock, a HOME shared between
    // machines) would otherwise never expire either.
    if (age > TTL_MS || age < -TTL_MS) return null;
    return raw.data;
  } catch {
    return null;
  }
}

export async function cacheSet(key, data) {
  await ensureCacheDir();
  await writeFile(join(CACHE_DIR, key + '.json'), JSON.stringify({ ts: Date.now(), data }));
}

/**
 * Drop the cached responses — and NOTHING else.
 *
 * ~/.cache/surf is not exclusively this cache: the rate limiter keeps its
 * learned ledger next door as ratelimit.json (per-key plan, the rps read off
 * Brave's headers, the monthly counter). Deleting every *.json here, as this
 * used to, made "clear the cache" quietly forget that a key is on a 50 rps
 * plan, so the next run paced it at the conservative 1 rps default — or, worse
 * on a 1 rps key, forgot the monthly quota entirely. Matching cacheKey()'s own
 * shape keeps the two kinds of state apart by construction, and protects any
 * future sibling file for free.
 */
export async function cacheClear() {
  if (!existsSync(CACHE_DIR)) return 0;
  const files = await readdir(CACHE_DIR);
  let n = 0;
  for (const f of files) {
    if (!ENTRY_RE.test(f)) continue;
    try {
      await unlink(join(CACHE_DIR, f));
      n++;
    } catch {
      // A concurrent clear got there first; not worth failing the command.
    }
  }
  return n;
}
