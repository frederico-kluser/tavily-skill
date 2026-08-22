// Per-provider key validators.
//
// Each validator runs a real 1-credit search call against the provider's
// API using the existing adapter. If the call returns 200, the key is
// valid; auth/billing errors mark it invalid; other errors are surfaced
// with their kind so the caller can decide whether to save anyway.
//
// Cost per validation:
//   - Tavily: 1 credit (~$0.001)
//   - Parallel: ~1 credit (lite tier)
//   - Brave: ~$0.003 (metered)
//
// This is a one-time cost per added key. Acceptable trade-off for
// "saved a working key" vs "saved a dead key and discovered hours later".

import { tavilyProvider } from '../lib/providers/tavily.mjs';
import { parallelProvider } from '../lib/providers/parallel.mjs';
import { braveProvider } from '../lib/providers/brave.mjs';
import { validateOpenRouterKey } from '../lib/ai/openrouter.mjs';

const ADAPTERS = {
  tavily: tavilyProvider,
  parallel: parallelProvider,
  brave: braveProvider,
};

const VERSION = '7.0.0';
const VALIDATION_QUERY = 'surf-agent-skill key validation ping';
const TIMEOUT_MS = 20_000;

/**
 * Validate a single API key by making a live search call.
 *
 * @param {string} provider  - 'tavily' | 'parallel' | 'brave'
 * @param {string} key
 * @returns {Promise<{
 *   valid: boolean,
 *   provider: string,
 *   latency_ms?: number,
 *   credits?: number,
 *   kind?: string,
 *   statusCode?: number,
 *   error?: string,
 * }>}
 */
export async function validateKey(provider, key) {
  // OpenRouter is an LLM provider, not a search provider: it validates via a
  // free key-introspection call (GET /api/v1/key), so adding a key costs $0
  // and burns no tokens.
  if (provider === 'openrouter') {
    return validateOpenRouterKey(key, { timeoutMs: TIMEOUT_MS });
  }

  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return {
      valid: false,
      provider,
      kind: 'unknown_provider',
      error: `unknown provider: ${provider}. Use: tavily | parallel | brave | openrouter`,
    };
  }
  if (!key || typeof key !== 'string' || key.length < 8) {
    return {
      valid: false,
      provider,
      kind: 'malformed',
      error: 'key is empty or too short',
    };
  }

  const ctx = { key, timeout: TIMEOUT_MS, version: VERSION };
  const t0 = Date.now();
  try {
    const result = await adapter.search(
      { query: VALIDATION_QUERY, max: 1, mode: 'fast' },
      ctx,
    );
    return {
      valid: true,
      provider,
      latency_ms: Date.now() - t0,
      credits: (result && result.usage && result.usage.credits) || 1,
    };
  } catch (e) {
    return {
      valid: false,
      provider,
      latency_ms: Date.now() - t0,
      kind: e.kind || 'network',
      statusCode: e.statusCode,
      error: e.message || String(e),
    };
  }
}

/**
 * Validate multiple keys, optionally in parallel.
 *
 * @param {Array<{provider: string, key: string}>} items
 * @param {object} [opts]
 * @param {boolean} [opts.parallel=false]  - run all validations in parallel
 * @returns {Promise<Array>}
 */
export async function validateAll(items, opts = {}) {
  if (opts.parallel) {
    return Promise.all(items.map(it => validateKey(it.provider, it.key)));
  }
  const out = [];
  for (const it of items) out.push(await validateKey(it.provider, it.key));
  return out;
}

/**
 * Human-readable summary of a validation result.
 *
 * @param {object} r  - result from validateKey
 * @returns {string}
 */
export function formatValidation(r) {
  if (r.valid && r.provider === 'openrouter') {
    const bits = [`HTTP 200`, `${r.latency_ms}ms`, 'free check'];
    if (r.label) bits.push(String(r.label));
    if (r.usage != null) bits.push(`used $${Number(r.usage).toFixed(4)}`);
    if (r.limit != null) bits.push(`limit $${Number(r.limit).toFixed(2)}`);
    else if (r.limit === null) bits.push('no credit limit');
    return `✓ valid (openrouter, ${bits.join(', ')})`;
  }
  if (r.valid) {
    return `✓ valid (${r.provider}, HTTP 200, ${r.latency_ms}ms, ${r.credits} credit${r.credits === 1 ? '' : 's'})`;
  }
  const kindMap = {
    auth:            'invalid key (401/403/422)',
    rate_limit_429:  'rate limit hit — key likely valid but throttled, try again',
    server_5xx:      "provider's server is down — try again later",
    network:         'network error reaching provider',
    malformed:       'key format is invalid',
    unknown_provider:'unknown provider',
    not_supported:   'provider does not support this validation method',
  };
  const reason = kindMap[r.kind] || r.kind || 'unknown error';
  const status = r.statusCode ? ` HTTP ${r.statusCode}` : '';
  const msg = r.error ? ` — ${r.error}` : '';
  return `✗ ${reason}${status}${msg}`;
}
