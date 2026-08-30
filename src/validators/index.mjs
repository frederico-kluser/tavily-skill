// Per-provider key validators.
//
// Each validator asks the provider's own API whether the key is real, using
// the cheapest call that provider offers. Auth errors mark the key invalid;
// other failures are surfaced with their kind so the caller can decide whether
// to save anyway.
//
// Cost per validation: ZERO, for both providers.
//   - Brave:      a request with no `q` is rejected before it is billed. A good
//                 key and a bad key both answer HTTP 422 and are told apart by
//                 error.code (VALIDATION vs SUBSCRIPTION_TOKEN_INVALID).
//   - OpenRouter: GET /api/v1/key is free key introspection.
//
// Because it is free, validation is not a one-off at setup time any more — the
// preflight gate (src/lib/preflight.mjs) can afford to prove the key on every
// run, cached for 7 days so it does not spend a rate-limit slot each time.

import { braveProvider } from '../lib/providers/brave.mjs';
import { validateOpenRouterKey } from '../lib/ai/openrouter.mjs';
// Single source of the version number: src/lib/version.mjs reads package.json.
// It rides along on the validation request's X-Client-Name.
import { VERSION } from '../lib/version.mjs';

const ADAPTERS = {
  brave: braveProvider,
};

const VALIDATION_QUERY = 'surf-agent-skill key validation ping';
const TIMEOUT_MS = 20_000;

/**
 * Validate a single API key against the provider's API.
 *
 * @param {string} provider  - 'brave' | 'openrouter'
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
      error: `unknown provider: ${provider}. Use: brave | openrouter`,
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

  // Adapters that know a free way to prove a key own that logic themselves.
  if (typeof adapter.validate === 'function') {
    return adapter.validate(key, { timeout: TIMEOUT_MS, version: VERSION });
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
    const cost = r.free || r.credits === 0 ? 'free probe, 0 credits' : `${r.credits} credit${r.credits === 1 ? '' : 's'}`;
    const note = r.throttled ? ', rate-limited but accepted' : '';
    return `✓ valid (${r.provider}, ${r.latency_ms}ms, ${cost}${note})`;
  }
  const kindMap = {
    auth:            'invalid key (Brave answers 422 SUBSCRIPTION_TOKEN_INVALID)',
    plan_gate:       'key is valid but your plan lacks this option',
    config_4xx:      'the request was malformed (the key itself may be fine)',
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
