// `surf-research-skill keys` subcommands: add, remove, list (status), reset, clear.

import {
  loadState, saveStateAtomic, clearBurned, blankProvider, nextResetIso,
  setValidation, getValidation, PROVIDERS, KEYS_FILE,
} from './state.mjs';
import { maskKey } from './flags.mjs';
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
    if (validation && !validation.valid) {
      results.push({ key, added: false, reason: `validation failed: ${formatValidation(validation)}`, validation });
      return;
    }
    state[provider].keys.push(key);
    const index = state[provider].keys.length - 1;
    // Record the verdict so the preflight gate does not re-prove this key on
    // the very next command. Free either way, but it costs a round-trip and a
    // slot in Brave's 1-second rate window.
    if (validation) {
      setValidation(state, provider, index, {
        ok: validation.valid, status: validation.statusCode, reason: validation.valid ? null : (validation.error || validation.kind),
      });
    }
    results.push({ key, added: true, index, validation });
  });
  for (const key of already) results.push({ key, added: false, reason: 'already exists' });

  if (!Number.isInteger(state[provider].current)) state[provider].current = 0;

  const addedCount = results.filter(r => r.added).length;
  if (addedCount) await saveStateAtomic(state);

  return { provider, addedCount, attempted: inputKeys.length, results, state };
}

export async function keysRemove(pos, flags) {
  const provider = requireProvider(flags);
  const target = pos[0];
  if (target == null) throw new Error('Usage: surf-research-skill keys remove --provider <name> <index|key>');
  const state = await loadState();
  const keys = state[provider].keys;
  let idx = -1;
  if (/^\d+$/.test(String(target))) {
    idx = Number(target);
  } else {
    idx = keys.indexOf(target);
  }
  if (idx < 0 || idx >= keys.length) throw new Error(`no key at '${target}' for provider '${provider}'`);
  keys.splice(idx, 1);
  // adjust current and burned indices
  if (state[provider].current >= keys.length) state[provider].current = 0;
  const reindex = (list) => (list || [])
    .filter(x => x.index !== idx)
    .map(x => (x.index > idx ? { ...x, index: x.index - 1 } : x));
  state[provider].burned = reindex(state[provider].burned);
  state[provider].cooldowns = reindex(state[provider].cooldowns);
  // Validation verdicts are per-INDEX; leaving them unshifted would attribute
  // one key's verdict to another.
  state[provider].validated = reindex(state[provider].validated);
  await saveStateAtomic(state);
  return { provider, removed: true, index: idx, state };
}

/**
 * Deep-copy the state with every key masked.
 *
 * `keys list --json` used to print raw keys. That is a real leak vector for
 * THIS package specifically: it exists to be driven by AI agents, whose stdout
 * lands in transcripts, handoff files and task plans that are then read back,
 * committed, or pasted. The human-readable form has always masked; the JSON
 * form silently did not.
 */
function maskState(state) {
  const out = { schema_version: state.schema_version, last_ok_provider: state.last_ok_provider };
  for (const p of PROVIDERS) {
    const pp = state[p] || {};
    out[p] = {
      ...pp,
      keys: (pp.keys || []).map(maskKey),
      key_count: (pp.keys || []).length,
    };
  }
  return out;
}

export async function keysList(_pos, flags) {
  const state = await loadState();
  // Opt in explicitly to get raw keys — and only when stdout is not a terminal
  // someone is screen-sharing. The flag name is deliberately unpleasant.
  if (flags.json) return { json: true, state: flags['unsafe-show-keys'] ? state : maskState(state) };
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
  return { provider, reset: true, state };
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
  return { cleared: true, state };
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
