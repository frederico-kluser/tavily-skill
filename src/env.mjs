// Key discovery for library mode.
// Priority (each level can contribute; results merged + deduped):
//   1. Explicit opts (opts.braveKey / opts.braveKeys / openrouter*)
//   2. process.env  (BRAVE_API_KEYS comma-separated + BRAVE_API_KEY,
//                    OPENROUTER_API_KEYS + OPENROUTER_API_KEY)
//   3. .env file at process.cwd() (lightweight regex parser, no dotenv dep)
//   4. ~/.config/surf/keys.json (CLI persistent store, fallback only)

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { loadState, PROVIDERS } from './lib/state.mjs';

// provider name -> env-var prefix. Kept explicit (rather than uppercasing the
// provider name) so a future provider whose slug differs from its env prefix
// doesn't silently break key discovery.
const ENV_BASE = {
  brave: 'BRAVE',
  openrouter: 'OPENROUTER',
};

const ENV_FILE_CACHE = new Map();

async function loadDotenv(dir) {
  if (ENV_FILE_CACHE.has(dir)) return ENV_FILE_CACHE.get(dir);
  const p = path.join(dir, '.env');
  const out = {};
  if (existsSync(p)) {
    try {
      const txt = await fs.readFile(p, 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?([^"#]*?)"?\s*(?:#.*)?$/);
        if (m) out[m[1]] = m[2].trim();
      }
    } catch {}
  }
  ENV_FILE_CACHE.set(dir, out);
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

function readFromObject(obj, base) {
  // base = 'BRAVE' | 'OPENROUTER'
  return [
    ...splitCsv(obj[`${base}_API_KEYS`]),
    obj[`${base}_API_KEY`],
  ].filter(Boolean);
}

// opts.braveKey / opts.braveKeys — camelCase option names per provider.
function explicitFor(opts, provider) {
  return [...arrayify(opts[`${provider}Key`]), ...arrayify(opts[`${provider}Keys`])];
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
    explicit[p] = explicitFor(opts, p);                        // Level 1
    env[p] = readFromObject(process.env, base);                // Level 2
    dotenv[p] = opts.skipDotenv ? [] : readFromObject(parsedDotenv, base); // Level 3
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
          if (needCfg(p)) cfg[p] = (state[p] && state[p].keys) || [];
        }
      } catch {}
    }
  }

  const out = {};
  for (const p of PROVIDERS) {
    out[p] = [...new Set([...explicit[p], ...env[p], ...dotenv[p], ...cfg[p]])];
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
 * The carry-over matches on key VALUE, never on index: discoverKeys merges four
 * sources through a Set, so positions in the merged array have nothing to do
 * with positions in keys.json. Keys that arrived from opts/env have no history
 * and start clean, which is correct.
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
      const oldIndexOf = new Map(src.keys.map((k, i) => [k, i]));
      keys.forEach((k, newIdx) => {
        const oldIdx = oldIndexOf.get(k);
        if (oldIdx === undefined) return;
        const b = (src.burned || []).find(x => x.index === oldIdx);
        if (b) burned.push({ ...b, index: newIdx });
        const c = (src.cooldowns || []).find(x => x.index === oldIdx);
        if (c) cooldowns.push({ ...c, index: newIdx });
        const v = (src.validated || []).find(x => x.index === oldIdx);
        if (v) validated.push({ ...v, index: newIdx });
      });
    }

    state[p] = { keys, current: 0, burned, cooldowns, validated };
  }
  return state;
}
