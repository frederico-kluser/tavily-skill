// `surf-research-skill keys` subcommands: add, remove, list (status), reset, clear.

import {
  loadState, saveStateAtomic, clearBurned, blankProvider, nextResetIso,
  setValidation, getValidation, PROVIDERS, KEYS_FILE,
} from './state.mjs';
import { maskKey } from './flags.mjs';
import { progress } from './progress.mjs';
import { validateAll, formatValidation } from '../validators/index.mjs';

// Read newline-delimited keys from stdin (for `keys add --provider X --stdin`
// or a `-` positional). Returns [] when nothing is piped so we never block.
async function readStdinKeys() {
  if (process.stdin.isTTY) return [];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// ------------------------------------------------ what a failure proves ---
//
// The ONE definition of "does this failure prove the KEY is bad?" —
// `provesKeyBad()` — lives in src/lib/preflight.mjs and is exported from
// there, so the gate and `keys add` share a single taxonomy instead of two
// copies of the same question (two copies were two ways to condemn a working
// key). The predicate below layers the ONE class this file sees and the gate
// never does on top of it; it is a second question, not a second answer.
//
// `keys add` used to make the mirror image of the mistake the gate used to
// make. The gate cached a wifi blip as "invalid key" for 7 days; `keys add`
// REFUSED a brand-new, perfectly good key with
// "validation failed: Brave network error..." and did not store it at all.
// Picture the person that lands on: they bought the key ten seconds ago, they
// are on hotel wifi or behind a corporate proxy, surf tells them the key does
// not work, and they go delete it and buy another one.
//
// Exactly ONE thing is evidence about the KEY: Brave rejecting the
// subscription token (kind 'auth' — a 401/403/402, or a 422 whose error.code
// is SUBSCRIPTION_TOKEN_INVALID). 'network' (dropped connection, DNS,
// timeout), 'server_5xx' (Brave is down) and any unattributed status from a
// captive portal or a proxy are evidence about the PATH to Brave. Whitelist,
// not blacklist: an unknown failure kind must not be able to convict a key.
//
// A 429 never even reaches here as a failure: the validator returns valid
// (throttled) for it, because being counted at all proves the token was
// accepted. Same for a plan gate.
//
// The one class this file sees that the gate never does: validateKey()
// refuses an empty/too-short key ('malformed') and an unknown provider
// ('unknown_provider') BEFORE any request leaves this machine. No path was
// travelled, so there is no path to blame — those stay refusals.
const DECIDED_WITHOUT_A_REQUEST = new Set(['malformed', 'unknown_provider']);

// The shared definition from the gate — a single taxonomy, exercised by the
// preflight gate and by `keys add` alike. Never grow a second copy here.
import { provesKeyBad as gateProvesKeyBad } from './preflight.mjs';

/**
 * Should `keys add` refuse this validate() result?
 *
 * The gate's own predicate (the shared definition of "proves the key bad")
 * plus the refusals this file decides before any request leaves the machine.
 * The import is named to keep the layering visible: one taxonomy, one local
 * additive exception, no second copy.
 */
function refuseOnValidation(r) {
  if (gateProvesKeyBad(r)) return true;
  return !!r && DECIDED_WITHOUT_A_REQUEST.has(r.kind);
}

/**
 * What to tell someone whose key was stored without ever being checked.
 * Plain sentences on purpose: the failure mode this repairs is a user reading
 * a diagnostic as a verdict and deleting a key that works.
 */
function unverifiedNote(v) {
  const why = (v && (v.error || v.kind)) ? ` (${v.error || v.kind})` : '';
  return 'saved, but NOT verified yet: surf could not reach Brave to check it'
    + why + '. Brave never rejected this key — no verdict was recorded against '
    + 'it, so the next surf command checks it again on its own, and checking is '
    + 'free. Do not delete this key because of this message.';
}

function requireProvider(flags, allowAll = false) {
  const p = flags.provider;
  if (!p) {
    if (allowAll && flags.all) return null;
    throw new Error(`--provider <${PROVIDERS.join('|')}> is required`);
  }
  if (!PROVIDERS.includes(p)) {
    throw new Error(`unknown provider '${p}' (valid: ${PROVIDERS.join(', ')})`);
  }
  return p;
}

// ---------------------------------------------------------------- masking ---
//
// EVERY value this module hands back to a caller is masked. Not just
// `keys list --json` — v8.0.1 wired the mask into `list` alone and left `add`,
// `remove` and `reset` printing `JSON.stringify(result)` with the raw key in
// it. This package exists to be driven by AI agents: its stdout lands in
// transcripts, handoff files and task plans that are read back, committed, and
// pasted into other models' context. A key on stdout is a leaked key.
//
// The one opt-out is `--unsafe-show-keys`, handled by the callers below.

/** Keys shorter than this are not searched for inside free text: too noisy. */
const REDACT_MIN_LEN = 8;

/** Every key the state knows about, across providers, longest first. */
function allKeys(state) {
  const out = [];
  for (const p of PROVIDERS) {
    const pp = (state && state[p]) || {};
    if (Array.isArray(pp.keys)) {
      for (const k of pp.keys) if (typeof k === 'string' && k) out.push(k);
    }
  }
  // Longest first so a key that is a prefix of another cannot mask it early.
  return out.sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of a real key inside free text with its mask. */
export function redactKeys(text, keys) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const k of keys) {
    if (typeof k !== 'string' || k.length < REDACT_MIN_LEN) continue;
    if (out.includes(k)) out = out.split(k).join(maskKey(k));
  }
  return out;
}

/** Deep copy of `value` with every occurrence of a key redacted from strings. */
function redactDeep(value, keys) {
  if (typeof value === 'string') return redactKeys(value, keys);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, keys));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactDeep(value[k], keys);
    return out;
  }
  return value;
}

/**
 * Redact any string in `value` against the keys held in `state`.
 * Exported for the CLI, which formats gate diagnostics from provider-supplied
 * text (Brave's `error.detail` is not guaranteed to be free of the token it is
 * complaining about).
 */
export function redactState(value, state) {
  return redactDeep(value, allKeys(state));
}

/**
 * Deep-copy the state with every key masked — and with every OTHER field
 * scrubbed of the raw key too. `...pp` used to copy `burned`, `cooldowns` and
 * `validated` through verbatim, and `validated[].reason` is provider-supplied
 * text: Brave answering "token BSA-xxx rejected" put the key straight back
 * into the "masked" output.
 */
export function maskState(state) {
  const st = state || {};
  const secrets = allKeys(st);
  const out = { schema_version: st.schema_version, last_ok_provider: st.last_ok_provider };
  for (const p of PROVIDERS) {
    const pp = st[p] || {};
    const keys = Array.isArray(pp.keys) ? pp.keys : [];
    const scrubbed = redactDeep({ ...pp }, secrets);
    delete scrubbed._inMemory;
    out[p] = {
      ...scrubbed,
      keys: keys.map(maskKey),
      key_count: keys.length,
    };
  }
  return out;
}

/** `state` as a caller may see it: masked, unless they asked for the raw one. */
function stateFor(state, flags) {
  return flags && flags['unsafe-show-keys'] ? state : maskState(state);
}

export async function keysAdd(pos, flags) {
  const provider = requireProvider(flags);

  // Collect one OR MANY keys: positionals plus optional stdin (newline-
  // delimited via --stdin or a `-` positional). Dedupe, preserve order.
  let inputKeys = pos.filter(k => k && k !== '-').map(k => String(k).trim());
  if (flags.stdin || pos.includes('-')) {
    inputKeys.push(...(await readStdinKeys()));
  }
  inputKeys = [...new Set(inputKeys.filter(Boolean))];

  if (!inputKeys.length) {
    throw new Error('Usage: surf-research-skill keys add --provider <name> <key...> [--stdin] [--skip-validate]');
  }

  const state = await loadState();
  const existing = new Set(state[provider].keys);
  const toAdd = inputKeys.filter(k => !existing.has(k));
  const already = inputKeys.filter(k => existing.has(k));

  // Live-validate the NEW keys in parallel (1 credit each, ~1-3s) before
  // saving. Opt out with --skip-validate (offline tests / known-good lists).
  let validations = [];
  if (!flags['skip-validate'] && toAdd.length) {
    validations = await validateAll(toAdd.map(key => ({ provider, key })), { parallel: true });
  }

  const results = [];
  toAdd.forEach((key, i) => {
    const validation = validations[i] || null;
    // Brave said no. That is the only refusal there is.
    if (refuseOnValidation(validation)) {
      results.push({ key, added: false, reason: `validation failed: ${formatValidation(validation)}`, validation });
      return;
    }
    // Nobody answered (network / 5xx / an unattributed status). The key is
    // stored anyway: we learned nothing about it, and refusing here throws
    // away a key the user just paid for on the strength of their wifi.
    const unproven = !!validation && validation.valid === false;
    state[provider].keys.push(key);
    const index = state[provider].keys.length - 1;
    // Record the verdict so the preflight gate does not re-prove this key on
    // the very next command. Free either way, but it costs a round-trip and a
    // slot in Brave's 1-second rate window.
    //
    // ONLY a real verdict is recorded, and only a positive one can come from
    // here. An `ok:false` written from a blip is the exact defect preflight.mjs
    // killed: it is persisted and honoured for 7 days, so three seconds of bad
    // wifi become a week of exit 78 on a key that works. Writing nothing costs
    // one free round-trip on the next run; writing it costs the week.
    if (validation && validation.valid) {
      setValidation(state, provider, index, {
        ok: true, status: validation.statusCode, reason: null,
      });
    }
    results.push({
      key, added: true, index,
      // `validation` is what the CLI renders as "(validated, ...)" — the one
      // thing that did not happen. The diagnostic keeps its own field.
      validation: unproven ? null : validation,
      ...(unproven ? {
        verified: false,
        probe: {
          kind: validation.kind || null,
          status: validation.statusCode ?? null,
          error: validation.error || null,
        },
        note: unverifiedNote(validation),
      } : {}),
    });
  });
  for (const key of already) results.push({ key, added: false, reason: 'already exists' });

  if (!Number.isInteger(state[provider].current)) state[provider].current = 0;

  const addedCount = results.filter(r => r.added).length;
  if (addedCount) await saveStateAtomic(state);

  // Nothing that leaves this function carries a raw key. `results[].key` is the
  // mask, and `validation`/`reason` are scrubbed too: they quote the provider's
  // own error text, which may echo the token back at us.
  const secrets = [...new Set([...inputKeys, ...allKeys(state)])].sort((a, b) => b.length - a.length);
  const safeResults = results.map(r => ({ ...redactDeep(r, secrets), key: maskKey(r.key) }));

  // Say it out loud, not only in the JSON. In text mode the CLI prints these
  // as a plain "✓ added [0] BSA…0001 to brave", which on its own reads as
  // "checked and fine". stderr, so `--json` stdout stays parseable — and
  // emitted from the REDACTED copy, because `probe.error` and `note` quote
  // the provider's own text, which is not guaranteed to be free of the token
  // it is complaining about.
  for (const r of safeResults) {
    if (r.added && r.verified === false) {
      progress.warn(`keys add: [${r.index}] ${r.key} ${r.note}`);
    }
  }

  return {
    provider,
    addedCount,
    attempted: inputKeys.length,
    results: flags['unsafe-show-keys'] ? results : safeResults,
    state: stateFor(state, flags),
  };
}

export async function keysRemove(pos, flags) {
  const provider = requireProvider(flags);
  const target = pos[0];
  if (target == null) throw new Error('Usage: surf-research-skill keys remove --provider <name> <index|key>');
  const state = await loadState();
  const keys = state[provider].keys;

  // BY VALUE FIRST, by index second. The old order tried /^\d+$/ first, so a
  // key whose literal value is "2" deleted whatever sat at index 2 — a
  // different, working key — and reported success. An exact value match is
  // never ambiguous; an index is only consulted when nothing matches.
  let idx = keys.indexOf(target);
  let matchedBy = 'value';
  if (idx < 0 && /^\d+$/.test(String(target))) {
    idx = Number(target);
    matchedBy = 'index';
  }
  if (idx < 0 || idx >= keys.length) throw new Error(`no key at '${target}' for provider '${provider}'`);

  const [removedKey] = keys.splice(idx, 1);
  // `current` is an index into the same array, so it shifts with everything
  // else. Clamping only when it ran off the end left it pointing at the NEXT
  // key whenever a key below it was removed.
  const p = state[provider];
  if (!Number.isInteger(p.current) || p.current < 0) p.current = 0;
  else if (idx < p.current) p.current -= 1;
  if (p.current >= keys.length) p.current = 0;

  const reindex = (list) => (list || [])
    .filter(x => x.index !== idx)
    .map(x => (x.index > idx ? { ...x, index: x.index - 1 } : x));
  state[provider].burned = reindex(state[provider].burned);
  state[provider].cooldowns = reindex(state[provider].cooldowns);
  // Validation verdicts are per-INDEX; leaving them unshifted would attribute
  // one key's verdict to another.
  state[provider].validated = reindex(state[provider].validated);
  await saveStateAtomic(state);
  return {
    provider,
    removed: true,
    index: idx,
    matched_by: matchedBy,
    key: maskKey(removedKey),
    state: stateFor(state, flags),
  };
}

export async function keysList(_pos, flags) {
  const state = await loadState();
  // Opt in explicitly to get raw keys — and only when stdout is not a terminal
  // someone is screen-sharing. The flag name is deliberately unpleasant.
  if (flags.json) return { json: true, state: stateFor(state, flags) };
  const lines = [];
  lines.push(`**Surf keys** (config: \`${KEYS_FILE}\`)`);
  lines.push(`last_ok_provider: \`${state.last_ok_provider || 'none'}\`\n`);
  for (const p of PROVIDERS) {
    const pp = state[p];
    const burnedIdx = new Set(pp.burned.map(b => b.index));
    const nowTs = Date.now();
    const coolingIdx = new Set((pp.cooldowns || []).filter(c => new Date(c.until).getTime() > nowTs).map(c => c.index));
    lines.push(`## ${p} (${pp.keys.length} key${pp.keys.length === 1 ? '' : 's'})`);
    if (!pp.keys.length) {
      lines.push(`_no keys — add with \`surf-research-skill keys add --provider ${p} <key>\`_\n`);
      continue;
    }
    pp.keys.forEach((k, i) => {
      const flags = [];
      if (i === pp.current) flags.push('current');
      if (burnedIdx.has(i)) flags.push('burned');
      if (coolingIdx.has(i)) flags.push('cooling');
      const v = getValidation(state, p, i);
      if (v) flags.push(v.ok ? `validated ${String(v.at).slice(0, 10)}` : 'INVALID');
      lines.push(`- [${i}] ${maskKey(k)}${flags.length ? '  *(' + flags.join(', ') + ')*' : ''}`);
    });
    if (pp.burned.length) {
      lines.push('');
      lines.push(`**Burned:**`);
      for (const b of pp.burned) {
        lines.push(`- index ${b.index} — reason: ${b.reason}, at ${b.at}, auto-reset on ${nextResetIso(b.at)}`);
      }
    }
    lines.push('');
  }
  lines.push(`## no key, no search`);
  lines.push(`- surf v8 is Brave-only. Without a valid Brave key every research command exits 78;`);
  lines.push(`  there is no free tier underneath and no other provider to fall back to.`);
  lines.push(`- A SECOND Brave key is not just redundancy: each key has its own per-second rate`);
  lines.push(`  budget, so two keys let twice as many sub-agents search at once.`);
  return { text: lines.join('\n') };
}

export async function keysReset(_pos, flags) {
  const state = await loadState();
  const provider = flags.provider ? requireProvider(flags) : null;
  clearBurned(state, provider);
  // Also drop cached FAILED verdicts and cooldowns. A reset means "try these
  // keys again"; leaving an `ok:false` entry behind would have the preflight
  // gate refuse the key without ever re-testing it, which is exactly the
  // situation the user ran reset to escape.
  for (const p of provider ? [provider] : PROVIDERS) {
    state[p].validated = (state[p].validated || []).filter(v => v.ok);
    state[p].cooldowns = [];
  }
  await saveStateAtomic(state);
  return { provider, reset: true, state: stateFor(state, flags) };
}

export async function keysClear(_pos, flags) {
  if (!flags.yes) {
    const tty = process.stdin && process.stdin.isTTY;
    if (!tty) {
      const err = new Error('non-interactive: pass --yes to confirm destructive clear');
      err.code = 'NEEDS_YES';
      throw err;
    }
  }
  const state = await loadState();
  // blankProvider(), not an inline literal: an inline one silently omits
  // `cooldowns` and `validated`, which normalizeProvider then has to repair.
  if (flags.all) {
    for (const p of PROVIDERS) state[p] = blankProvider();
    state.last_ok_provider = null;
  } else {
    const provider = requireProvider(flags);
    state[provider] = blankProvider();
    if (state.last_ok_provider === provider) state.last_ok_provider = null;
  }
  await saveStateAtomic(state);
  return { cleared: true, state: stateFor(state, flags) };
}

export async function runKeysSubcommand(sub, pos, flags) {
  switch (sub) {
    case 'add': return keysAdd(pos, flags);
    case 'remove':
    case 'rm':
    case 'delete': return keysRemove(pos, flags);
    case 'list':
    case 'ls':
    case 'status': return keysList(pos, flags);
    case 'reset': return keysReset(pos, flags);
    case 'clear': return keysClear(pos, flags);
    default:
      throw new Error(`unknown 'surf-research-skill keys' subcommand: '${sub}'. Valid: add, remove, list, reset, clear`);
  }
}
