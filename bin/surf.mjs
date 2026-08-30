#!/usr/bin/env node
// `surf` — bundle wrapper for surf-research-skill + surf-plan-skill.
//
// Running `surf` with no args launches an interactive setup that:
//   1. Verifies EVERY skill this package installs is present (symlinks live,
//      not dangling) — the list is read from the installer, never re-typed
//   2. Lists currently-configured keys per provider
//   3. Offers an interactive menu: add / list / remove / doctor / quit
//   4. EVERY key added is validated LIVE against the provider's API before
//      being saved. Both validations are FREE: Brave rejects a q-less request
//      before billing it, and OpenRouter exposes free key introspection. The
//      verdict is cached in keys.json so the preflight gate stays offline.
//
// This is the friendliest entry point. `surf-research-skill` and `surf-plan-skill`
// remain available for power users and scripts.

import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadState, saveStateAtomic, setValidation, KEYS_FILE, PROVIDERS, SEARCH_PROVIDERS } from '../src/lib/state.mjs';
import { validateKey, formatValidation } from '../src/validators/index.mjs';
// Namespace import on purpose. SKILLS IS exported now, but a named import of a
// binding that ever goes away is a link-time SyntaxError — the whole CLI dies,
// not just the doctor. Through the namespace, a missing SKILLS is a plain
// `undefined` and canonicalSkillNames() falls through to its next tier.
import * as harnessInstall from '../src/lib/harness-install.mjs';
import { gateStatus, resolveGate, GATE, formatGate, EXIT_CONFIG } from '../src/lib/preflight.mjs';
import { runAiSetup } from '../src/lib/ai/setup.mjs';
import { keysFromEnv, PRIMARY_MODEL } from '../src/lib/ai/openrouter.mjs';
// Single source of the version number: src/lib/version.mjs reads package.json.
import { VERSION } from '../src/lib/version.mjs';

const { HARNESS_DIRS } = harnessInstall;

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_INSTALL_SRC = path.join(PKG_ROOT, 'src', 'lib', 'harness-install.mjs');

const HELP = `surf — multi-skill setup & validation

Bundles surf-research-skill (Brave web search + the surf-ai autonomous research
loop) and surf-plan-skill (research-driven execution planning) into one command.

surf v8 searches with Brave and nothing else. No valid Brave key means every
research command stops with exit 78 — it never answers from somewhere else.

Commands:
  (no args)              Interactive setup wizard (add keys with live validation)
  ai-key                 Add the OpenRouter key that powers surf-ai
  add                    Add a key (you'll be asked for provider + key)
  list                   List configured keys (masked) + last-known state
  validate [provider]    Re-validate all keys (or just one provider's)
  remove <provider> <i>  Remove key #i from provider
  doctor [--offline]     Diagnostics: skills installed? keys valid? harness symlinks?
                         By default a key with no cached verdict costs ONE live
                         probe (free — no credit, no quota). --offline skips it
                         and reports only what keys.json already knows.
  --help, -h             Show this help
  --version, -v          Show version

Power-user CLIs (also installed):
  surf-search-normal ... surf-ai, ONE wave (fits the agent's bash timeout)
  surf-search-unlimit ...surf-ai, as many waves as the question needs
  surf-research-skill ...The search engine (search / search-parallel)
  surf-plan-skill ...    The planning skill (list/show/new/doctor)

Providers:
  brave        the ONE search backend. Required. Each key carries its own
               per-second rate budget, so a second key doubles the fan-out.
  openrouter   the LLM surf-ai plans + synthesizes with — NOT a search
               provider (default model: ${PRIMARY_MODEL})

Keys live in:        ${KEYS_FILE} (chmod 600)
Plans live in:       ~/.claude/plans/<slug>-<timestamp>.md (or ./plans/)
SKILL.md (search):   ~/.agents/skills/surf-research-agent-skill/SKILL.md
Brave API notes:     references/brave-api.md
SKILL.md (planning): ~/.agents/skills/surf-plan-agent-skill/SKILL.md
`;

function out(s = '') {
  stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
}
function err(s) {
  stderr.write(s + (s.endsWith('\n') ? '' : '\n'));
}
function mask(key) {
  if (!key || key.length < 8) return key;
  return key.slice(0, 5) + '…' + key.slice(-4);
}
function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * WHICH SKILLS THIS PACKAGE INSTALLS — read, never re-typed.
 *
 * This used to be `['surf-research-agent-skill', 'surf-plan-agent-skill']`,
 * hardcoded right here. The installer's own list (SKILLS in
 * src/lib/harness-install.mjs) grew a third entry, surf-search-agent-skill,
 * and started symlinking it into all four harness dirs — 12 links — while the
 * doctor kept checking two names and reported a clean bill of health for an
 * install that was missing a skill entirely. A second copy of a list is a
 * second thing to forget.
 *
 * Three tiers, in order of authority:
 *   1. `harnessInstall.SKILLS` — the export itself. THIS is the tier that runs
 *      today: harness-install.mjs exports the array, so the doctor reads the
 *      exact object the installer loops over. Nothing to parse, nothing to
 *      drift. `surf doctor` names the tier it used, so a regression is visible.
 *   2. the SKILLS literal read out of that module's SOURCE — the same
 *      canonical list, fetched the awkward way. Kept as the belt for a build
 *      where the export is gone or renamed.
 *   3. last resort, the package layout the installer walks: the root skill
 *      plus every directory under skills/. Only reachable if the file cannot
 *      be read at all, and it keeps a blind doctor from being a silent one.
 * Adding a fourth skill to SKILLS therefore needs no edit in this file.
 */
async function canonicalSkillNames() {
  if (Array.isArray(harnessInstall.SKILLS)) {
    const names = harnessInstall.SKILLS.map(s => s && s.name).filter(Boolean);
    if (names.length) return { names, source: 'harness-install.mjs (exported SKILLS)' };
  }
  try {
    const src = await fs.readFile(HARNESS_INSTALL_SRC, 'utf8');
    const block = src.match(/const\s+SKILLS\s*=\s*\[([\s\S]*?)\]\s*;/);
    const names = block
      ? [...block[1].matchAll(/\bname\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1])
      : [];
    if (names.length) return { names, source: 'harness-install.mjs (SKILLS literal)' };
  } catch {}
  try {
    const entries = await fs.readdir(path.join(PKG_ROOT, 'skills'), { withFileTypes: true });
    const names = ['surf-research-agent-skill', ...entries.filter(e => e.isDirectory()).map(e => e.name)];
    return { names, source: 'package layout (skills/*)' };
  } catch {}
  return { names: [], source: null };
}

async function detectSkills() {
  const { names, source } = await canonicalSkillNames();
  const found = {};
  for (const skill of names) {
    found[skill] = { dirs: [] };
    for (const dir of HARNESS_DIRS) {
      const link = path.join(dir, skill);
      // lstat, NOT existsSync: existsSync FOLLOWS the link, so a DANGLING
      // symlink — precisely what `npm i -g` leaves behind when the package dir
      // moves — was indistinguishable from "nothing installed here". The two
      // states deserve different sentences: one harness is broken, and
      // "reinstall" is the fix for a link that is missing, not for one that is
      // there and points at nothing.
      let stat = null;
      try { stat = await fs.lstat(link); } catch { continue; }
      const isSymlink = stat.isSymbolicLink();
      found[skill].dirs.push({
        path: link,
        isSymlink,
        isDir: stat.isDirectory(),
        broken: isSymlink && !existsSync(link),
      });
    }
  }
  return { names, source, found };
}

async function cmdList() {
  const state = await loadState();
  out(`**Keys** (config: \`${KEYS_FILE}\`, chmod 600)`);
  out(`last_ok_provider: \`${state.last_ok_provider || 'none yet'}\``);
  out('');
  for (const p of PROVIDERS) {
    const ps = state[p];
    out(`## ${p} (${ps.keys.length} key${ps.keys.length === 1 ? '' : 's'})`);
    if (!ps.keys.length) {
      out(`  _no keys — add with \`surf add\`_`);
      continue;
    }
    for (let i = 0; i < ps.keys.length; i++) {
      const isCur = i === ps.current ? ' (current)' : '';
      const burned = ps.burned.find(b => b.index === i);
      const burn = burned ? ` BURNED:${burned.reason} at ${burned.at.slice(0, 16)}` : '';
      out(`  [${i}] ${mask(ps.keys[i])}${isCur}${burn}`);
    }
  }
}

async function cmdValidate(providerFilter) {
  const state = await loadState();
  let any = false;
  for (const p of PROVIDERS) {
    if (providerFilter && p !== providerFilter) continue;
    const ps = state[p];
    if (!ps.keys.length) continue;
    any = true;
    out(`\n## ${p}`);
    for (let i = 0; i < ps.keys.length; i++) {
      stdout.write(`  [${i}] ${mask(ps.keys[i])} → `);
      const r = await validateKey(p, ps.keys[i]);
      out(formatValidation(r));
    }
  }
  if (!any) out(providerFilter ? `No keys for ${providerFilter}.` : 'No keys configured. Add one with `surf add`.');
}

async function cmdRemove(args) {
  const [provider, indexStr] = args;
  if (!provider || indexStr == null) {
    err('Usage: surf remove <provider> <index>');
    process.exit(1);
  }
  if (!PROVIDERS.includes(provider)) {
    err(`Unknown provider: ${provider}. Use: ${PROVIDERS.join('|')}`);
    process.exit(1);
  }
  const idx = Number(indexStr);
  const state = await loadState();
  const ps = state[provider];
  if (!Number.isInteger(idx) || idx < 0 || idx >= ps.keys.length) {
    err(`Invalid index ${indexStr}; ${provider} has ${ps.keys.length} key${ps.keys.length === 1 ? '' : 's'} (0-${ps.keys.length - 1}).`);
    process.exit(1);
  }
  const removed = ps.keys.splice(idx, 1)[0];
  ps.burned = ps.burned.filter(b => b.index !== idx).map(b => ({ ...b, index: b.index > idx ? b.index - 1 : b.index }));
  if (ps.current >= ps.keys.length) ps.current = 0;
  await saveStateAtomic(state);
  out(`✓ removed ${provider} key #${idx} (${mask(removed)})`);
}

async function cmdAdd(rl) {
  rl = rl || readline.createInterface({ input: stdin, output: stdout });
  let closeRl = !arguments.length;
  try {
    out('');
    let provider = '';
    while (!PROVIDERS.includes(provider)) {
      provider = (await rl.question(`Provider [${PROVIDERS.join('/')}]: `)).trim().toLowerCase();
      if (!PROVIDERS.includes(provider)) out(`  (unknown: ${provider}. Try: ${PROVIDERS.join(', ')})`);
    }
    const key = (await rl.question(`${provider} key: `)).trim();
    if (!key) { out('(empty — cancelled)'); return; }

    const state = await loadState();
    const ps = state[provider];
    if (ps.keys.includes(key)) {
      out(`  ℹ already configured at index ${ps.keys.indexOf(key)} — skipping`);
      return;
    }

    out(`  validating against the ${provider} API (free — no credits, no quota)…`);
    const r = await validateKey(provider, key);
    out(`  ${formatValidation(r)}`);
    if (!r.valid) {
      out('  → key NOT saved. Try `surf add` again with a different key.');
      process.exitCode = 1;
      return;
    }

    ps.keys.push(key);
    if (ps.keys.length === 1) ps.current = 0;
    await saveStateAtomic(state);
    setValidation(state, provider, ps.keys.length - 1, { ok: true, status: r.statusCode });
    await saveStateAtomic(state);
    out(`✓ saved as ${provider} key #${ps.keys.length - 1}. Total ${provider}: ${ps.keys.length}.`);
  } finally {
    if (closeRl) rl.close();
  }
}

async function cmdDoctor({ offline = false } = {}) {
  out('## Skills');
  const { names, source, found } = await detectSkills();
  if (!names.length) {
    // Never fail quiet here: an empty list would check nothing and print
    // nothing, which reads exactly like "all good".
    out(`  ✗ could not read the canonical skill list (SKILLS in ${HARNESS_INSTALL_SRC})`);
    out(`    → this build cannot tell you which skills should be installed`);
    process.exitCode = 1;
  } else {
    out(`  (${names.length} skill${names.length === 1 ? '' : 's'} per ${source}, across ${HARNESS_DIRS.length} harness dirs)`);
  }
  for (const [skill, info] of Object.entries(found)) {
    const live = info.dirs.filter(d => !d.broken);
    const broken = info.dirs.filter(d => d.broken);
    if (!live.length) {
      out(broken.length
        ? `  ✗ ${skill}: ${broken.length} DANGLING symlink(s), 0 working`
        : `  ✗ ${skill}: NOT found in any harness skill dir`);
      for (const d of broken) out(`      ${d.path} → target is gone`);
      out(`    → reinstall: npm i -g surf-agent-skill@latest`);
      process.exitCode = 1;
    } else {
      out(`  ✓ ${skill}: ${live.length} harness${live.length === 1 ? '' : 'es'}`);
      for (const d of live) out(`      ${d.path}${d.isSymlink ? ' (symlink)' : ''}`);
      if (broken.length) {
        out(`  ✗ ${skill}: ${broken.length} DANGLING symlink(s) — those harnesses cannot load it`);
        for (const d of broken) out(`      ${d.path} → target is gone`);
        out(`    → repair: npm i -g surf-agent-skill@latest`);
        process.exitCode = 1;
      }
    }
  }

  out('\n## Keys');
  const state = await loadState();
  const totals = PROVIDERS.map(p => ({ p, n: state[p].keys.length, burned: state[p].burned.length }));
  for (const t of totals) {
    const status = t.n === 0 ? '⚠ no keys' : t.burned ? `${t.n} key(s), ${t.burned} burned` : `${t.n} key(s) ✓`;
    const note = t.p === 'openrouter' ? '   (surf-ai LLM, not a search provider)' : '   (the search backend)';
    out(`  ${t.p.padEnd(10)} ${status}${note}`);
  }

  // A count is not a verdict. The previous doctor happily reported
  // "brave 1 key(s), 1 burned" and exited 0 — the exact state in which every
  // research command fails. Ask the gate instead.
  //
  // WHY THIS PROBES BY DEFAULT
  // --------------------------
  // resolveGate() spends at most ONE live validation, and only when the key
  // has no cached verdict — the single case where no offline answer exists.
  // It costs no Brave credit (a q-less request is rejected before billing) and
  // the result is cached for 7 days, so a doctor run on a settled machine puts
  // nothing on the wire. Staying offline here would be worse than useless: the
  // offline gate cannot return UNREACHABLE, so a machine with a dead network
  // and a never-judged key would be told `unvalidated`, exit 0 — and the very
  // next search would exit 78. A doctor used as a gate has to predict the
  // command that follows it, not flatter it.
  //   --offline (or SURF_DOCTOR_OFFLINE=1) opts out for callers that must not
  // touch the network; it then refuses to certify what it did not check.
  out('\n## Brave key gate (this is what every command checks)');
  const offlineOnly = offline || process.env.SURF_DOCTOR_OFFLINE === '1';
  out(offlineOnly
    ? '  (offline: keys.json only — nothing left this machine)'
    : '  (a cached verdict costs nothing; an unjudged key costs ONE free probe)');
  const verdict = offlineOnly
    ? gateStatus(state, 'brave')
    : await resolveGate(state, 'brave', { persist: true });
  if (verdict.verdict === GATE.READY) {
    out(`  ✓ ready — key #${verdict.index} (${verdict.detail})`);
  } else if (offlineOnly && verdict.verdict === GATE.UNVALIDATED) {
    // Not a verdict — the absence of one. Saying "ready" here is the lie this
    // command exists to stop, and saying "broken" would be one in the other
    // direction, so it says neither and does not touch the exit code.
    out(`  ⚠ undecided — key #${verdict.index} is configured but was never judged,`);
    out(`    and --offline forbids the one free probe that would settle it.`);
    out(`    Run \`surf doctor\` without --offline for a real verdict.`);
  } else {
    const { text } = formatGate(verdict.verdict, verdict.detail, 'brave');
    for (const line of text.split('\n')) out(`  ${line}`);
    process.exitCode = EXIT_CONFIG;
  }

  out('\n## surf-ai');
  const envOr = keysFromEnv();
  const orTotal = state.openrouter.keys.length + envOr.length;
  if (orTotal) {
    out(`  ✓ ready — ${state.openrouter.keys.length} stored key(s)` +
        (envOr.length ? ` + ${envOr.length} from OPENROUTER_API_KEY(S)` : ''));
    out(`    default model: ${PRIMARY_MODEL}`);
    out('    surf-search-normal "question" --task … --goal … --insights …');
    out('    surf-search-unlimit "question" --sub-agents=10 --max-depth 3');
  } else {
    out('  ⚠ no OpenRouter key — surf-ai will fall back to its deterministic,');
    out('    LLM-free path (real searches, no synthesis). Turn it on with:');
    out('      surf ai-key            (or: surf-research-skill ai-setup)');
  }

  out('\n## Plans');
  const plansDir = path.join(os.homedir(), '.claude', 'plans');
  if (existsSync(plansDir)) {
    const files = (await fs.readdir(plansDir)).filter(f => f.endsWith('.md'));
    out(`  ${files.length} plan file${files.length === 1 ? '' : 's'} in ${plansDir}`);
  } else {
    out(`  ${plansDir} not created yet`);
  }
}

async function interactiveMenu() {
  out('');
  out('┌─ surf — multi-skill setup & validation ─────────────────');
  out(`│ Skills detected:`);
  const { names, found } = await detectSkills();
  // Widest name, not a magic 20: 'surf-research-agent-skill' is 25 chars, so
  // the column never lined up and a longer future name would look worse still.
  const width = names.reduce((w, n) => Math.max(w, n.length), 0);
  for (const [skill, info] of Object.entries(found)) {
    const live = info.dirs.filter(d => !d.broken);
    const broken = info.dirs.length - live.length;
    const status = live.length
      ? `✓ ${live.length} harness${live.length === 1 ? '' : 'es'}${broken ? ` (+${broken} DANGLING)` : ''}`
      : (broken ? `✗ ${broken} DANGLING symlink(s)` : '✗ NOT INSTALLED');
    out(`│   ${skill.padEnd(width)} ${status}`);
  }

  const state = await loadState();
  const counts = PROVIDERS.map(p => `${p} ${state[p].keys.length}`).join(', ');
  out(`│ Keys: ${counts}`);
  out(`│ Config: ${KEYS_FILE}`);
  out('└──────────────────────────────────────────────────────────');
  out('');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      out('What do you want to do?');
      out('  [1] Add a Brave search key (live-validated, free)');
      out('  [2] Add the OpenRouter key that powers surf-ai');
      out('  [3] List + revalidate all keys');
      out('  [4] Remove a key');
      out('  [5] Diagnostics (skills + symlinks + dirs)');
      out('  [q] Quit');
      const choice = (await rl.question('> ')).trim().toLowerCase();
      out('');
      if (choice === '1' || choice === 'add') {
        await cmdAdd(rl);
      } else if (choice === '2' || choice === 'ai' || choice === 'ai-key') {
        await runAiSetup();
      } else if (choice === '3' || choice === 'list') {
        await cmdValidate();
      } else if (choice === '4' || choice === 'remove') {
        const provider = (await rl.question(`Provider [${PROVIDERS.join('/')}]: `)).trim();
        const idx = (await rl.question('Index: ')).trim();
        await cmdRemove([provider, idx]).catch(e => err(`✗ ${e.message}`));
      } else if (choice === '5' || choice === 'doctor') {
        await cmdDoctor();
      } else if (choice === 'q' || choice === 'quit' || choice === 'exit' || !choice) {
        out('bye 🌊');
        return;
      } else {
        out(`(unknown choice: ${choice})`);
      }
      out('');
    }
  } finally {
    rl.close();
  }
}

const [, , cmd, ...rest] = process.argv;

try {
  if (!cmd) {
    if (!stdin.isTTY) {
      err(`surf requires a TTY for interactive setup. Use a subcommand:
  surf add | list | validate | remove <provider> <i> | doctor`);
      process.exit(1);
    }
    await interactiveMenu();
  } else if (cmd === '--help' || cmd === '-h') {
    out(HELP);
  } else if (cmd === '--version' || cmd === '-v') {
    out(VERSION);
  } else if (cmd === 'add') {
    if (!stdin.isTTY) {
      err('`surf add` is interactive and requires a TTY. Use `surf-research-skill keys add --provider X <key>` for scripts.');
      process.exit(1);
    }
    await cmdAdd();
  } else if (cmd === 'ai-key' || cmd === 'ai-setup') {
    await runAiSetup({ key: rest[0] });
  } else if (cmd === 'list') {
    await cmdList();
  } else if (cmd === 'validate') {
    await cmdValidate(rest[0]);
  } else if (cmd === 'remove') {
    await cmdRemove(rest);
  } else if (cmd === 'doctor') {
    await cmdDoctor({ offline: rest.includes('--offline') });
  } else {
    err(`Unknown command: ${cmd}. Try 'surf --help'.`);
    process.exit(1);
  }
} catch (e) {
  err(`❌ Error: ${e.message || String(e)}`);
  process.exit(1);
}
