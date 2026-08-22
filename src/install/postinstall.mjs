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
} from '../lib/harness-install.mjs';

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
process.stdout.write('✓ surf-agent-skill 7.0.0 installed globally — 3 skills + 6 bins:\n');
  process.stdout.write('    surf                  interactive setup with live key validation\n');
  process.stdout.write('    surf-research-skill   web research: search, parallel fan-out, or async\n');
  process.stdout.write('                          deep research — auto-routed by the skill itself\n');
  process.stdout.write('    surf-plan-skill       research-grounded execution planning, with an\n');
  process.stdout.write('                          auto-routed ambiguity-sweep mode for high-stakes work\n');
  process.stdout.write('    surf-free-skill       free, keyless web search (Wikipedia + DuckDuckGo)\n');
  process.stdout.write('                          — no API key needed\n');
  process.stdout.write('\n');
  process.stdout.write('  → Next: run `surf` to add keys (each one is live-validated)\n');
  process.stdout.write('  → Then ask your AI agent: "make a plan for X" (planning skill kicks in)\n');
  process.stdout.write('         or run: surf-research-skill search "your query"\n');
}

main().catch(e => {
  // NEVER fail npm install. Print warning + exit 0.
  process.stderr.write(`surf-agent-skill postinstall warning: ${e.message}\n`);
  process.stderr.write('  (skill is installed; harness symlinks may need manual setup)\n');
  process.exit(0);
});
