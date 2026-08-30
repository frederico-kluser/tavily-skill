#!/usr/bin/env node
// Runs after `npm install`. Idempotent. Must never fail npm install.
// - Detects global vs local install.
// - Global: symlinks/copies package into the 4 supported harness skill dirs,
//   creates ~/.config/surf/keys.json skeleton, cleans legacy 'tavily'/'surf'/'tvly'
//   symlinks from prior versions.
// - Local: just prints "installed as library" and exits.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installSkill,
  cleanupLegacy,
  ensureKeysSkeleton,
  SKILLS,
} from '../lib/harness-install.mjs';
// Version and bin list come from package.json (src/lib/version.mjs). This
// banner used to hardcode both numbers and got both wrong: it announced 8.0.0
// after package.json moved to 8.0.1, and "2 skills" after the installer had
// started symlinking three into four harness dirs (12 links).
import { VERSION, BIN_NAMES } from '../lib/version.mjs';

// Prose only. The NAMES printed below come from package.json's "bin", so a bin
// added or dropped there is reflected here without a second edit; a bin with no
// blurb still gets listed, just without a description.
const BIN_BLURBS = {
  'surf': ['interactive setup with live key validation'],
  'surf-research-skill': ['Brave web search: one query, a batch, or a',
                          'paced parallel fan-out'],
  'surf-search-normal': ['autonomous research, ONE wave'],
  'surf-search-unlimit': ['autonomous research, as many waves as needed'],
  'surf-plan-skill': ['research-grounded execution planning, with an',
                      'auto-routed ambiguity-sweep mode for high-stakes work'],
};
const plural = (n) => (n === 1 ? '' : 's');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..', '..');

const isGlobal = process.env.npm_config_global === 'true';
// Some CI environments don't set npm_config_global; also treat the case where
// __dirname is under a global node_modules path as "global enough".
const looksGlobal = /node_modules\/surf-agent-skill\/src\/install$/.test(__dirname) ||
                    /node_modules\\surf-agent-skill\\src\\install$/.test(__dirname);
// Dev override: `SURF_DEV=1 node src/install/postinstall.mjs` simulates the
// global install from the source checkout (used by `npm run dev:install`).
const isDev = process.env.SURF_DEV === '1';

async function main() {
  if (!isGlobal && !looksGlobal && !isDev) {
    // Local install: don't touch user system. Library mode.
    process.stdout.write('surf-agent-skill installed as a library (npm i surf-agent-skill).\n');
    process.stdout.write('  → For the global CLI: npm i -g surf-agent-skill\n');
    process.stdout.write('  → To import: import { search } from "surf-agent-skill"\n');
    return;
  }

  if (isDev) {
    process.stdout.write('⚙ SURF_DEV=1 — simulating global install from local checkout\n');
    process.stdout.write(`  symlinks will point at: ${pkgRoot}\n`);
    process.stdout.write('  undo with: npm run dev:uninstall\n\n');
  }

  // Cleanup legacy symlinks from earlier versions BEFORE creating new ones.
  const legacy = await cleanupLegacy();
  for (const r of legacy) {
    process.stdout.write(`✓ removed legacy ${r.removed}\n`);
  }

  // Install symlinks into each harness skill dir.
  const installed = await installSkill(pkgRoot);
  for (const r of installed) {
    if (r.action === 'error') {
      process.stdout.write(`⚠ ${r.dir}: ${r.error}\n`);
    } else {
      const verb = {
        symlinked: '✓ symlinked',
        copied: '✓ copied (no symlink permission)',
        'kept-symlink': '✓ already linked',
        'preserved-existing': 'ℹ preserved your existing copy at',
      }[r.action] || r.action;
      process.stdout.write(`${verb} ${r.dir}\n`);
    }
  }

  // Create state dir + skeleton keys.json.
  const skel = await ensureKeysSkeleton();
  if (skel.created) process.stdout.write(`✓ created ${skel.created} (chmod 600)\n`);

  process.stdout.write('\n');
  // Both counts are COUNTED, never typed: skills from the installer's own list,
  // bins from package.json. BIN_NAMES is empty only if package.json could not be
  // read at all, in which case fall back to the names we have prose for.
  const bins = BIN_NAMES.length ? BIN_NAMES : Object.keys(BIN_BLURBS);
  process.stdout.write(
    `✓ surf-agent-skill ${VERSION} installed globally — ` +
    `${SKILLS.length} skill${plural(SKILLS.length)} + ${bins.length} bin${plural(bins.length)}:\n`
  );
  for (const name of bins) {
    const [first = '', ...rest] = BIN_BLURBS[name] || [];
    process.stdout.write(`${`    ${name.padEnd(22)}${first}`.trimEnd()}\n`);
    for (const line of rest) process.stdout.write(`${' '.repeat(26)}${line}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write('  ⚠ v8 is BRAVE-ONLY. Tavily and Parallel were removed; if you had keys for\n');
  process.stdout.write('    them they are copied to ~/.config/surf/keys.legacy-<date>.json, not deleted.\n');
  process.stdout.write('    Without a valid Brave key every research command now exits 78.\n');
  process.stdout.write('\n');
  process.stdout.write('  → Next: run `surf` to add your Brave key (validated live, for free)\n');
  process.stdout.write('  → Then ask your AI agent: "make a plan for X" (planning skill kicks in)\n');
  process.stdout.write('         or run: surf-research-skill search "your query"\n');
}

main().catch(e => {
  // NEVER fail npm install. Print warning + exit 0.
  process.stderr.write(`surf-agent-skill postinstall warning: ${e.message}\n`);
  process.stderr.write('  (skill is installed; harness symlinks may need manual setup)\n');
  process.exit(0);
});
