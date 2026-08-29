// State management: ~/.config/surf/keys.json with atomic writes, lockfile,
// monthly auto-reset of burned keys, a cached validation verdict per key, and
// one-shot migrations for two pieces of history: the legacy
// ~/.cache/tavily-skill/ directory, and Tavily/Parallel key sections left over
// from v7 (rescued to a sidecar file, never silently deleted).

import { mkdir, readFile, writeFile, rename, rm, stat, chmod, readdir, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
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

async function acquireLock(timeoutMs = 2000) {
  await ensureConfigDir();
  const start = Date.now();
  let backoff = 20;
  while (true) {
    try {
      const fh = await open(LOCK_FILE, 'wx');
      await fh.close();
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        try { await rm(LOCK_FILE, { force: true }); } catch {}
        const fh = await open(LOCK_FILE, 'wx').catch(() => null);
        if (fh) { await fh.close(); return; }
        throw new Error('Could not acquire keys.json lock');
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 200);
    }
  }
}

async function releaseLock() {
  try { await rm(LOCK_FILE, { force: true }); } catch {}
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
    // pay a round-trip on every invocation. Entries older than the TTL are
    // pruned here, which is also what makes the TTL authoritative in one place.
    // NOTE: this object literal is a WHITELIST — a field not listed here is
    // silently dropped by the next saveStateAtomic.
    validated: Array.isArray(obj.validated)
      ? obj.validated.filter(v => v && typeof v === 'object' && Number.isInteger(v.index)
          && typeof v.at === 'string' && now - new Date(v.at).getTime() < VALIDATION_TTL_MS)
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
 */
export function nextResetIso(burnedAt) {
  const d = new Date(burnedAt);
  if (Number.isNaN(d.getTime())) return '—';
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

/** The cached validation verdict for one key index, or null. */
export function getValidation(state, provider, index) {
  const p = state[provider];
  if (!p || !Array.isArray(p.validated)) return null;
  const hit = p.validated.find(v => v.index === index);
  if (!hit) return null;
  const at = new Date(hit.at).getTime();
  if (!Number.isFinite(at) || Date.now() - at > VALIDATION_TTL_MS) return null;
  return hit;
}

/** Record a live validation verdict for one key index. */
export function setValidation(state, provider, index, { ok, status, reason } = {}) {
  const p = state[provider];
  if (!p) return;
  if (!Array.isArray(p.validated)) p.validated = [];
  const entry = { index, at: new Date().toISOString(), ok: !!ok, status: status ?? null, reason: reason ?? null };
  const i = p.validated.findIndex(v => v.index === index);
  if (i >= 0) p.validated[i] = entry;
  else p.validated.push(entry);
}

/** Forget a cached verdict (after a burn, or when the key list shifts). */
export function clearValidation(state, provider, index) {
  const p = state[provider];
  if (!p || !Array.isArray(p.validated)) return;
  p.validated = index === undefined
    ? []
    : p.validated.filter(v => v.index !== index);
}

function applyMonthlyReset(state) {
  const now = new Date();
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth();
  for (const p of PROVIDERS) {
    const before = state[p].burned.length;
    state[p].burned = state[p].burned.filter(b => {
      const at = new Date(b.at);
      if (Number.isNaN(at.getTime())) return false;
      return !(nowY > at.getUTCFullYear() || (nowY === at.getUTCFullYear() && nowM > at.getUTCMonth()));
    });
    if (state[p].burned.length !== before) {
      // current may now point to a slot that became usable again — leave as-is;
      // nextUsableKeyIndex will surface the lowest usable.
    }
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
  return out;
}

export async function loadState({ skipMonthlyReset = false } = {}) {
  await ensureConfigDir();
  let raw = blankState();
  if (existsSync(KEYS_FILE)) {
    try {
      const txt = await readFile(KEYS_FILE, 'utf8');
      const parsed = JSON.parse(txt);
      const rescued = await rescueLegacyProviderKeys(parsed);
      if (rescued) {
        process.stderr.write(
          `\u26a0 surf v8 is Brave-only. Your Tavily/Parallel keys were copied to ${rescued} ` +
          `before being removed from keys.json — nothing was destroyed.\n`,
        );
      }
      raw = normalizeFullState(parsed);
    } catch {
      raw = blankState();
    }
  } else {
    await saveStateAtomic(raw);
  }
  if (!skipMonthlyReset) applyMonthlyReset(raw);
  return raw;
}

export async function saveStateAtomic(state) {
  await ensureConfigDir();
  await acquireLock();
  try {
    const safe = normalizeFullState(state);
    const tmp = KEYS_FILE + '.tmp';
    const payload = JSON.stringify(safe, null, 2);
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, KEYS_FILE);
    try { await chmod(KEYS_FILE, 0o600); } catch {}
  } finally {
    await releaseLock();
  }
}

export function providerHasUsableKey(state, provider) {
  const p = state[provider];
  if (!p || !p.keys.length) return false;
  const burnedIdx = new Set(p.burned.map(b => b.index));
  return p.keys.some((_, i) => !burnedIdx.has(i));
}

export function nextUsableKeyIndex(state, provider, skipIndex = -1) {
  const p = state[provider];
  if (!p || !p.keys.length) return -1;
  const burnedIdx = new Set(p.burned.map(b => b.index));
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
  const p = state[provider];
  if (!p) return;
  if (!Array.isArray(p.cooldowns)) p.cooldowns = [];
  const until = new Date(untilMs).toISOString();
  const existing = p.cooldowns.find(c => c.index === index);
  if (existing) existing.until = until;
  else p.cooldowns.push({ index, until });
}

export function cooldownActive(providerState, index, now = Date.now()) {
  if (!providerState || !Array.isArray(providerState.cooldowns)) return false;
  const c = providerState.cooldowns.find(x => x.index === index);
  if (!c) return false;
  const until = new Date(c.until).getTime();
  return Number.isFinite(until) && until > now;
}

export function markBurned(state, provider, index, reason) {
  const p = state[provider];
  if (!p) return;
  // A burn overrides any cached "valid" verdict: proof from the live API beats
  // a week-old cache entry.
  clearValidation(state, provider, index);
  if (p.burned.some(b => b.index === index)) return;
  p.burned.push({ index, at: new Date().toISOString(), reason: String(reason || 'unknown') });
  while (p.burned.length > BURNED_CAP) p.burned.shift();
}

export function clearBurned(state, provider) {
  if (provider) state[provider].burned = [];
  else for (const p of PROVIDERS) state[p].burned = [];
}

/**
 * Why a provider cannot serve a request right now, in words a user can act on.
 *
 * The old NoProviderAvailable message always said "keys add", even when the
 * user had a perfectly good key that had merely been burned — for which the fix
 * is `keys reset`, not another key. One function, so every throw site agrees.
 */
export function explainUnusable(state, provider) {
  const p = state[provider];
  if (!p || !p.keys.length) {
    return { reason: 'no key configured', fix: `surf-research-skill keys add --provider ${provider} <key>` };
  }
  const burnedIdx = new Set(p.burned.map(b => b.index));
  const usable = p.keys.map((_, i) => i).filter(i => !burnedIdx.has(i));
  if (!usable.length) {
    const b = p.burned[0] || {};
    return {
      reason: `all ${p.keys.length} key(s) burned (${b.reason || 'auth'}, at ${b.at || 'unknown'}; auto-resets ${nextResetIso(b.at)})`,
      fix: `surf-research-skill keys reset --provider ${provider}`,
    };
  }
  const now = Date.now();
  const cooling = usable.filter(i => cooldownActive(p, i, now));
  if (cooling.length === usable.length) {
    const c = (p.cooldowns || []).find(x => x.index === cooling[0]);
    return {
      reason: `all usable key(s) are cooling down after a rate limit until ${c ? c.until : 'shortly'}`,
      fix: 'wait for the cooldown to expire, or add another key to widen the rate budget',
    };
  }
  return null;
}

/**
 * One-shot rescue of keys belonging to providers this version no longer
 * supports. v8.0.0 dropped Tavily and Parallel; silently deleting paid keys
 * from a user's config would be indefensible, so they are copied out first.
 */
async function rescueLegacyProviderKeys(parsed) {
  const legacy = {};
  for (const name of ['tavily', 'parallel']) {
    const sec = parsed && parsed[name];
    if (sec && Array.isArray(sec.keys) && sec.keys.length) legacy[name] = sec;
  }
  if (!Object.keys(legacy).length) return null;
  const file = join(CONFIG_DIR, `keys.legacy-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    if (!existsSync(file)) {
      await writeFile(file, JSON.stringify(legacy, null, 2), { mode: 0o600 });
    }
    return file;
  } catch {
    return null;
  }
}

export async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}
