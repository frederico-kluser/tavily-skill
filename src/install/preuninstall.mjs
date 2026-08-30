#!/usr/bin/env node
// Runs before `npm rm -g surf-agent-skill`. Removes our symlinks; leaves user state.
//
// Two sweeps, in this order:
//   1. uninstallSkill() — the names this version installs. Ownership-proved:
//      only an ABSOLUTE symlink resolving exactly onto our package dies.
//   2. cleanupLegacy()  — every name this package ever advertised. Without it
//      `npm rm -g` left the harness still announcing surf-free-agent-skill,
//      the v7 keyless Wikipedia/DuckDuckGo search that v8 DELETED outright:
//      the SKILL.md link survived, the binary behind it did not. An agent
//      would read a keyless-search promise and find nothing to run — the one
//      failure mode deleting that skill was supposed to make structural.
//      postinstall has always run this sweep; the uninstall path never did.
//
// Nothing in here may be loud. npm runs it while the package is being torn
// down and package.json wraps it in `|| true`, so a throw would not stop the
// removal — but it would print a stack trace over the user's terminal, and it
// would skip whatever work came after it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uninstallSkill, cleanupLegacy } from '../lib/harness-install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..', '..');

// A closed pipe or a full disk must not turn a cleanup into a crash: on
// /dev/full the write throws synchronously, and on a closed reader EPIPE
// arrives as an 'error' event with no listener, which is a fatal uncaught
// exception. Both would abort the sweeps that had not run yet.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
function say(s) { try { process.stdout.write(s); } catch { /* stdout is gone; keep cleaning */ } }

// Each sweep is isolated. A harness dir that is unreadable, unwritable, or not
// a directory at all is one dir's problem: it costs one line, never the rest of
// the sweep and never the sweep that follows.
async function sweep(label, fn) {
  try {
    return await fn();
  } catch (e) {
    say(`⚠ ${label}: ${(e && e.message) || e}\n`);
    return [];
  }
}

async function main() {
  const results = await sweep('skill links', () => uninstallSkill(pkgRoot));
  for (const r of results) {
    if (r.removed) say(`✓ removed ${r.dir}\n`);
    else if (r.error) say(`⚠ ${r.dir}: ${r.error}\n`);
  }

  // LEGACY_NAMES lives in harness-install.mjs and stays there — one list, read
  // by both install paths, no copy to drift. cleanupLegacy() uses lstat, not
  // existsSync, so it catches the most common shape of all: a DANGLING legacy
  // link pointing at a binary v8 already removed (existsSync follows the link
  // and would answer "not there"). And it unlinks symlinks only, so a real
  // file or directory a user parked under one of those names survives, as does
  // whatever any link points AT — we remove link entries, never targets.
  const legacy = await sweep('legacy cleanup', () => cleanupLegacy());
  for (const r of legacy) say(`✓ removed legacy ${r.removed}\n`);

  say('\nsurf-agent-skill uninstalled.\n');
  say('  → Your keys at ~/.config/surf/keys.json are preserved.\n');
  say('  → To wipe: rm -rf ~/.config/surf ~/.cache/surf\n');
}

main().catch(e => {
  // Last resort only: both sweeps already swallow their own failures. Message
  // only — a stack trace here would be the loudest possible way to end an
  // uninstall that actually succeeded.
  try { process.stderr.write(`surf-agent-skill preuninstall warning: ${(e && e.message) || e}\n`); } catch {}
  process.exit(0);
});
