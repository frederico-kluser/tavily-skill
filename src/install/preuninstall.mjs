#!/usr/bin/env node
// Runs before `npm rm -g surf-agent-skill`. Removes our symlinks; leaves user state.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uninstallSkill } from '../lib/harness-install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const results = await uninstallSkill(pkgRoot);
  for (const r of results) {
    if (r.removed) process.stdout.write(`✓ removed ${r.dir}\n`);
    else if (r.error) process.stdout.write(`⚠ ${r.dir}: ${r.error}\n`);
  }
  process.stdout.write('\nsurf-agent-skill uninstalled.\n');
  process.stdout.write('  → Your keys at ~/.config/surf/keys.json are preserved.\n');
  process.stdout.write('  → To wipe: rm -rf ~/.config/surf ~/.cache/surf\n');
}

main().catch(e => {
  process.stderr.write(`surf-agent-skill preuninstall warning: ${e.message}\n`);
  process.exit(0);
});
