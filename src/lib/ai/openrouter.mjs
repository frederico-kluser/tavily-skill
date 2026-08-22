// OpenRouter chat client — the LLM half of surf-ai.
//
// This module is deliberately paranoid. It is the only place in the codebase
// that talks to an LLM, and the whole point of surf-ai is that the CALLING
// AGENT never has to handle a failure: rate limits, dead keys, exhausted
// credit, a model that went away, a provider that 503s mid-flight, a reply
// that isn't valid JSON — all of it is absorbed here.
//
// Resilience ladder, tried in order until something works:
//   1. model chain     — primary model, then progressively cheaper/older ones
//   2. key rotation    — every non-burned, non-cooling OpenRouter key
//   3. retry + backoff — 429 and 5xx get capped exponential backoff w/ jitter
//   4. schema downgrade— if a model/provider rejects json_schema, re-ask in
//                        plain text with a "JSON only" instruction
//   5. loose parsing   — fenced blocks, prose preamble, trailing commentary
//
// Only when EVERY rung fails does this throw AiUnavailableError, and the
// orchestrator degrades to its keyless heuristic path rather than failing.
//
// Auth:   Authorization: Bearer <key>
// Docs:   https://openrouter.ai/docs/api-reference/overview
// Models: https://openrouter.ai/deepseek

import { sleep } from '../flags.mjs';
import { markBurned, setCooldown, cooldownActive } from '../state.mjs';
import { progress } from '../progress.mjs';

export const OPENROUTER_BASE =
  process.env.SURF_OPENROUTER_BASE || 'https://openrouter.ai/api/v1';

// Default model chain. `deepseek/deepseek-v4-pro` is the requested primary;
// the rest are fallbacks so a deprecated slug, a capacity blip, or a provider
// outage degrades instead of failing. Override the primary with
// SURF_AI_MODEL (or --ai-model); the fallbacks always stay behind it.
//
// Chain verified live against GET https://openrouter.ai/api/v1/models on
// 2026-08-01 — every slug here has serving endpoints and lists
// `structured_outputs` in supported_parameters. Slugs that appear on
// openrouter.ai/deepseek but return an EMPTY endpoints array (notably
// deepseek/deepseek-v3.2-speciale) are deliberately excluded: they are listed
// but unserved, and requesting one fails with no-available-provider.
export const PRIMARY_MODEL = 'deepseek/deepseek-v4-pro';
export const FALLBACK_MODELS = [
  'deepseek/deepseek-v4-flash-0731', // newest V4 Flash, 1M ctx, ~3x cheaper
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-chat-v3.1',
];

const DEFAULT_TIMEOUT_MS = Number(process.env.SURF_AI_TIMEOUT_MS) || 120_000;
// Sideline a key for this long after it exhausts its 429 retries.
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.SURF_AI_COOLDOWN_MS) || 45_000;
const REFERER = 'https://github.com/frederico-kluser/surf-agent-skill';
const TITLE = 'surf-agent-skill';

export class AiUnavailableError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = 'AiUnavailable';
    this.attempts = attempts;
  }
}

/**
 * Resolve the model chain: explicit override (if any) first, then the primary,
 * then the fallbacks — deduped, order preserved.
 */
export function resolveModels(override) {
  const first = override || process.env.SURF_AI_MODEL || null;
  return [...new Set([first, PRIMARY_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
}

function backoff(attempt) {
  // Capped exponential with equal jitter — same shape as dispatch.mjs so
  // retry storms across the two layers don't synchronize.
  const capped = Math.min(1200 * (attempt + 1) ** 2, 8000);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/**
 * Map an OpenRouter HTTP status + body to the same error taxonomy the search
 * providers use, so the retry logic reads the same everywhere.
 */
export function mapError(status, body) {
  const err = (body && body.error) || {};
  const msg = err.message || (body && body.message) || `HTTP ${status}`;
  const meta = err.metadata || {};

  if (status === 401) return { kind: 'auth', statusCode: status, message: 'invalid OpenRouter key' };
  // 402 = out of credits. The key is real but unusable until the user tops up,
  // so burning it (rather than cooling it) is correct: rotate to the next key.
  if (status === 402) return { kind: 'auth', statusCode: status, message: msg || 'OpenRouter: insufficient credits' };
  if (status === 403) {
    // Moderation refusals also come back 403. Those are about the PROMPT, not
    // the key — burning the key there would be wrong.
    if (meta.reasons || /moderat|flagged/i.test(msg)) {
      return { kind: 'caller_4xx', statusCode: status, message: msg || 'OpenRouter: input flagged by moderation' };
    }
    return { kind: 'auth', statusCode: status, message: msg || 'OpenRouter: forbidden' };
  }
  if (status === 408) return { kind: 'network', statusCode: status, message: msg || 'OpenRouter: request timed out' };
  if (status === 429) return { kind: 'rate_limit_429', statusCode: status, message: msg || 'OpenRouter rate limit' };
  if (status === 404) {
    // `provider.require_parameters: true` makes OpenRouter answer 404 — NOT
    // 400 — when no endpoint of an otherwise-valid model implements the
    // parameters we sent (verified live 2026-08-01). Treating that as "unknown
    // model" would throw away a perfectly good model over a schema it can
    // still answer in plain text, so route it to the schema downgrade.
    if (/no endpoints found|requested parameters|provider-selection|routing/i.test(msg)) {
      return { kind: 'bad_schema', statusCode: status, message: msg };
    }
    return { kind: 'bad_model', statusCode: status, message: msg || 'OpenRouter: unknown model' };
  }
  if (status === 400) {
    // A schema the routed provider can't honor surfaces as a 400 mentioning
    // response_format / json_schema / structured outputs.
    if (/response_format|json_schema|structured output|schema/i.test(msg)) {
      return { kind: 'bad_schema', statusCode: status, message: msg };
    }
    return { kind: 'caller_4xx', statusCode: status, message: msg };
  }
  // 503 = "no available provider meets your routing requirements". When we
  // asked for require_parameters that is a constraint problem, not an outage:
  // the caller downgrades the schema before treating it as a server error.
  if (status === 503) return { kind: 'no_provider', statusCode: status, message: msg || 'OpenRouter: no provider met the routing requirements' };
  if (status >= 500) return { kind: 'server_5xx', statusCode: status, message: msg || 'OpenRouter server error' };
  if (status >= 400) return { kind: 'caller_4xx', statusCode: status, message: msg };
  return { kind: 'caller_4xx', statusCode: status, message: msg };
}

/**
 * Seconds to wait from a Retry-After header. OpenRouter sends it on 429 and
 * 503; the docs are explicit that raw-fetch callers must honor it themselves,
 * and that the X-RateLimit-* headers are not reliably readable.
 */
export function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return 0;
  const raw = headers.get('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const when = Date.parse(raw); // HTTP-date form
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 60_000);
  return 0;
}

async function postChat(body, key, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), Math.max(1000, timeoutMs));
  const t0 = Date.now();
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Optional attribution headers; OpenRouter uses them for the app
        // leaderboard. Harmless when the referer isn't registered.
        'HTTP-Referer': REFERER,
        'X-Title': TITLE,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return {
      status: res.status, ok: res.ok, data,
      retryAfterMs: retryAfterMs(res.headers),
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    clearTimeout(t);
    const network = e.name === 'AbortError' || /timeout|abort/i.test(e.message || '')
      ? `OpenRouter request exceeded ${timeoutMs}ms`
      : `OpenRouter network error: ${e.message}`;
    throw Object.assign(new Error(network), { kind: 'network' });
  }
}

/**
 * Pull the assistant text out of a chat completion, tolerating the shapes
 * different upstream providers emit (string content, content parts array,
 * reasoning-only replies).
 */
function extractText(data) {
  const choice = data && Array.isArray(data.choices) && data.choices[0];
  if (!choice) return '';
  const msg = choice.message || {};
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  if (Array.isArray(msg.content)) {
    const joined = msg.content
      .map(part => (typeof part === 'string' ? part : (part && part.text) || ''))
      .join('')
      .trim();
    if (joined) return joined;
  }
  // Some reasoning models put everything in `reasoning` when they hit a length
  // cap before emitting content. Better than returning nothing.
  if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) return msg.reasoning;
  return '';
}

/**
 * Parse JSON out of a model reply that may be wrapped in prose or fences.
 * Returns null when nothing parseable is found — callers treat that as a
 * failed attempt and retry, never as an empty result.
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();

  try { return JSON.parse(trimmed); } catch {}

  // ```json … ``` or ``` … ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }

  // First balanced {...} or [...] in the text. Scans with a depth counter and
  // a string-literal guard so braces inside strings don't unbalance it.
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = trimmed.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

/**
 * OpenRouter keys found in the environment.
 *
 * The search-provider keys are deliberately file-only (they are read from
 * ~/.config/surf/keys.json and never from env). The LLM key gets one extra
 * source, because `OPENROUTER_API_KEY` is already exported in most developer
 * shells and CI jobs — refusing it would mean surf-ai reports "no usable key"
 * on a machine that plainly has one. Env keys are used in memory only; they
 * are never written to keys.json.
 */
export function keysFromEnv(env = process.env) {
  const csv = typeof env.OPENROUTER_API_KEYS === 'string'
    ? env.OPENROUTER_API_KEYS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const single = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim()
    ? [env.OPENROUTER_API_KEY.trim()]
    : [];
  return [...new Set([...csv, ...single])];
}

/**
 * Merge env-discovered OpenRouter keys into the loaded state, in place.
 * Stored keys keep priority; env keys are appended after them. The count of
 * stored keys is remembered so `snapshotForPersist` can strip the env ones
 * back out before anything is written to disk. Returns how many were added.
 */
export function mergeEnvKeys(state, env = process.env) {
  if (!state.openrouter) state.openrouter = { keys: [], current: 0, burned: [], cooldowns: [] };
  const stored = state.openrouter.keys.length;
  const have = new Set(state.openrouter.keys);
  const added = keysFromEnv(env).filter(k => !have.has(k));
  if (!added.length) return 0;
  state.openrouter._storedKeyCount = stored;
  state.openrouter.keys.push(...added);
  return added.length;
}

/**
 * A copy of the state that is safe to write to keys.json: env-sourced
 * OpenRouter keys are removed, along with any burn/cooldown markers that
 * pointed at them (their indexes are meaningless once the keys are gone).
 * A key the user exported in their shell must never end up persisted.
 */
export function snapshotForPersist(state) {
  const snap = { ...state };
  delete snap._inMemory;
  const or = state.openrouter;
  if (!or || typeof or._storedKeyCount !== 'number') return snap;
  const n = or._storedKeyCount;
  snap.openrouter = {
    keys: or.keys.slice(0, n),
    current: (or.current || 0) < n ? or.current : 0,
    burned: (or.burned || []).filter(b => b.index < n),
    cooldowns: (or.cooldowns || []).filter(c => c.index < n),
  };
  return snap;
}

function usableKeyIndexes(providerState) {
  const keys = (providerState && providerState.keys) || [];
  if (!keys.length) return [];
  const burned = new Set(((providerState && providerState.burned) || []).map(b => b.index));
  const now = Date.now();
  const start = Math.max(0, Math.min(providerState.current || 0, keys.length - 1));
  const order = [];
  for (let off = 0; off < keys.length; off++) {
    const i = (start + off) % keys.length;
    if (burned.has(i)) continue;
    if (cooldownActive(providerState, i, now)) continue;
    order.push(i);
  }
  // If every key is cooling (but none burned), use them anyway rather than
  // giving up — a cooldown is a preference, not a hard block.
  if (!order.length) {
    for (let i = 0; i < keys.length; i++) if (!burned.has(i)) order.push(i);
  }
  return order;
}

/**
 * Core LLM call with the full resilience ladder.
 *
 * @param {object} o
 * @param {string} o.system            system prompt
 * @param {string} o.user              user prompt
 * @param {object} [o.schema]          JSON Schema — when present, the reply is
 *                                     parsed and returned as an object
 * @param {string} [o.schemaName]      name for the json_schema block
 * @param {object} o.state             keys.json state (openrouter section read)
 * @param {string} [o.model]           model override (goes first in the chain)
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {string} [o.label]           progress-log label
 * @returns {Promise<{value:any, text:string, model:string, key_index:number,
 *                    latency_ms:number, usage:object, attempts:Array}>}
 */
export async function chat(o) {
  const {
    system, user, schema, schemaName = 'surf_ai_response',
    state, model, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens, temperature = 0.2, label = 'llm',
  } = o;

  const ps = (state && state.openrouter) || { keys: [], burned: [], cooldowns: [], current: 0 };
  const attempts = [];

  if (!usableKeyIndexes(ps).length) {
    throw new AiUnavailableError(
      'no usable OpenRouter key — run `surf-research-skill ai-setup` (or `surf ai-key`) to add one',
      attempts,
    );
  }

  const models = resolveModels(model);
  const persist = typeof o.onStateChange === 'function' ? o.onStateChange : null;

  for (const modelId of models) {
    // `schemaMode` degrades within a model: structured → plain-text JSON.
    let schemaMode = schema ? 'json_schema' : 'text';

    // Recomputed per model: a key burned while trying the previous model must
    // not be retried here, and a cooldown may have expired in the meantime.
    const keyOrder = usableKeyIndexes(ps);
    if (!keyOrder.length) break; // nothing left to try on any model

    for (const keyIdx of keyOrder) {
      let consecutive5xx = 0;

      for (let attempt = 0; attempt < 3; attempt++) {
        const body = {
          model: modelId,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: schemaMode === 'json_text' ? `${user}\n\nReply with ONE valid JSON document and nothing else — no prose, no markdown fence.` : user },
          ],
          temperature,
          usage: { include: true },
        };
        if (maxTokens) body.max_tokens = maxTokens;
        if (schemaMode === 'json_schema') {
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: schemaName, strict: true, schema },
          };
          // Route only to upstream providers that actually implement the
          // parameters we sent, instead of silently dropping the schema.
          body.provider = { require_parameters: true };
        }

        progress.start(`${label} → ${modelId} (key #${keyIdx}${schemaMode === 'json_text' ? ', plain-json' : ''})`);

        let res;
        try {
          res = await postChat(body, ps.keys[keyIdx], timeoutMs);
        } catch (e) {
          attempts.push({ model: modelId, key_index: keyIdx, kind: 'network', message: e.message });
          if (attempt < 2) { await sleep(backoff(attempt) / 2); continue; }
          break; // next key
        }

        if (res.ok) {
          // OpenRouter can return HTTP 200 with an embedded error object when
          // the upstream fails after the connection is established.
          if (res.data && res.data.error && !Array.isArray(res.data.choices)) {
            const m = mapError(res.data.error.code >= 400 ? res.data.error.code : 502, res.data);
            attempts.push({ model: modelId, key_index: keyIdx, ...m });
            if (m.kind === 'rate_limit_429' && attempt < 2) { await sleep(backoff(attempt)); continue; }
            break;
          }

          const text = extractText(res.data);
          if (!text.trim()) {
            attempts.push({ model: modelId, key_index: keyIdx, kind: 'empty', message: 'empty completion' });
            if (attempt < 2) { await sleep(300); continue; }
            break;
          }

          let value = text;
          if (schema) {
            value = parseJsonLoose(text);
            if (value == null) {
              attempts.push({ model: modelId, key_index: keyIdx, kind: 'unparseable', message: 'reply was not JSON' });
              // Escalate the degradation once, then just retry.
              if (schemaMode === 'json_schema') {
                schemaMode = 'json_text';
                progress.retry(`${label} ${modelId}: reply not JSON — retrying without response_format`);
                continue;
              }
              if (attempt < 2) { await sleep(300); continue; }
              break;
            }
          }

          // Success — remember the key that worked.
          if (ps.keys.length) ps.current = keyIdx;
          if (persist) persist();
          const usage = (res.data && res.data.usage) || {};
          progress.success(
            `${label} ${modelId} ${res.latency_ms}ms` +
            (usage.total_tokens ? ` (${usage.total_tokens} tok` + (usage.cost != null ? `, $${Number(usage.cost).toFixed(5)}` : '') + ')' : '')
          );
          return {
            value, text, model: modelId, key_index: keyIdx,
            latency_ms: res.latency_ms, usage, attempts,
          };
        }

        const m = mapError(res.status, res.data);
        attempts.push({ model: modelId, key_index: keyIdx, ...m });

        if (m.kind === 'bad_model') {
          progress.warn(`${label} ${modelId} unavailable (404) — trying next model`);
          break; // abandon this model entirely
        }
        if (m.kind === 'bad_schema') {
          if (schemaMode === 'json_schema') {
            schemaMode = 'json_text';
            progress.retry(`${label} ${modelId}: structured output rejected — retrying as plain JSON`);
            continue;
          }
          break;
        }
        if (m.kind === 'auth') {
          progress.warn(`${label} OpenRouter key #${keyIdx} burned (${m.statusCode})`);
          markBurned(state, 'openrouter', keyIdx, String(m.statusCode || 'auth'));
          if (persist) persist();
          break; // next key
        }
        if (m.kind === 'rate_limit_429') {
          if (attempt < 2) {
            // Honor Retry-After when OpenRouter sends it — it is the only
            // reliable rate-limit signal (the X-RateLimit-* headers are not
            // exposed to clients). Fall back to our own backoff otherwise.
            const wait = res.retryAfterMs || backoff(attempt);
            progress.retry(`${label} 429 — waiting ${wait}ms (attempt ${attempt + 1}/3)${res.retryAfterMs ? ' [Retry-After]' : ''}`);
            await sleep(wait);
            continue;
          }
          setCooldown(state, 'openrouter', keyIdx, Date.now() + Math.max(RATE_LIMIT_COOLDOWN_MS, res.retryAfterMs || 0));
          if (persist) persist();
          break; // next key
        }
        if (m.kind === 'no_provider') {
          // 503 under require_parameters means our schema constraint left no
          // eligible endpoint — drop the constraint before blaming the model.
          if (schemaMode === 'json_schema') {
            schemaMode = 'json_text';
            progress.retry(`${label} ${modelId}: no endpoint met the structured-output requirement — retrying as plain JSON`);
            continue;
          }
          if (attempt < 2) {
            const wait = res.retryAfterMs || backoff(attempt);
            progress.retry(`${label} 503 — waiting ${wait}ms`);
            await sleep(wait);
            continue;
          }
          break; // next key, then next model
        }
        if (m.kind === 'server_5xx') {
          consecutive5xx++;
          if (attempt < 2 && consecutive5xx < 3) {
            progress.retry(`${label} ${m.statusCode} — backoff ${backoff(attempt)}ms`);
            await sleep(backoff(attempt));
            continue;
          }
          break; // next key (and eventually next model)
        }
        // caller_4xx / anything else: the request itself is the problem —
        // another key won't help, but another model might (different upstream
        // provider, different moderation).
        break;
      }
    }
  }

  const summary = attempts.slice(-4).map(a => `${a.model}#${a.key_index}:${a.kind}`).join('; ');
  throw new AiUnavailableError(
    `every OpenRouter model/key combination failed${summary ? ' (' + summary + ')' : ''}`,
    attempts,
  );
}

/** Convenience: structured JSON call. Returns the parsed object. */
export async function chatJson(o) {
  const r = await chat({ ...o, schema: o.schema });
  return r;
}

/** Convenience: free-form text call (used for the final synthesis). */
export async function chatText(o) {
  const r = await chat({ ...o, schema: undefined });
  return r;
}

/**
 * Validate an OpenRouter key with a free, non-generating call.
 * GET /api/v1/key returns the key's label, limit and usage.
 */
export async function validateOpenRouterKey(key, { timeoutMs = 20_000 } = {}) {
  if (!key || typeof key !== 'string' || key.length < 8) {
    return { valid: false, provider: 'openrouter', kind: 'malformed', error: 'key is empty or too short' };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { 'Authorization': `Bearer ${key}` },
      signal: ctl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (res.ok) {
      const d = (data && data.data) || {};
      return {
        valid: true,
        provider: 'openrouter',
        latency_ms: Date.now() - t0,
        credits: 0, // key introspection is free
        label: d.label,
        limit: d.limit,
        usage: d.usage,
        free_tier: d.is_free_tier,
      };
    }
    const m = mapError(res.status, data);
    return { valid: false, provider: 'openrouter', latency_ms: Date.now() - t0, ...m, error: m.message };
  } catch (e) {
    clearTimeout(t);
    return {
      valid: false, provider: 'openrouter', latency_ms: Date.now() - t0,
      kind: 'network', error: e.message || String(e),
    };
  }
}
