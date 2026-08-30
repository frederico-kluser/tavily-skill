#!/usr/bin/env node
// Propagate package.json's version into the one place that cannot import it:
// the `metadata.version` line of each shipped SKILL.md front matter.
//
// WHY THIS EXISTS
// Everything else in this package reads src/lib/version.mjs, which reads
// package.json — bump package.json and the five binaries, the X-Client-Name
// header and the postinstall banner all move together. SKILL.md front matter
// is YAML, parsed by the agent harness before any JavaScript of ours runs, so
// it cannot import anything. It is the ONE hand-copied number left, and it had
// already drifted three different ways: 8.0.1 (root), 8.0.0 (plan skill),
// 8.1.0 (search skill) against a package.json that said 8.0.1.
//
// SO IT IS SYNCED BY MACHINE, AND GUARDED BY THE GATE
//   · `npm run sync:version` rewrites the three files from package.json.
//   · `npm version <x>` runs it automatically (the "version" lifecycle script)
//     and stages the result, so a normal release edits nothing by hand.
//   · `npm run sync:version -- --check` (and test/smoke.mjs, on every `npm
//     test`) FAILS on drift and names this command as the fix.
//
// No dependencies, no YAML parser: it rewrites exactly one line per file,
// inside the front-matter block, and refuses to touch a file whose shape it
// does not recognise.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The SKILL.md files that carry a metadata.version, relative to the package root. */
export const SKILL_MD_FILES = [
  'SKILL.md',
  path.join('skills', 'surf-plan-agent-skill', 'SKILL.md'),
  path.join('skills', 'surf-search-agent-skill', 'SKILL.md'),
];

/**
 * The `version:` line inside the leading `---` front-matter block.
 * Returns { line, indent, quote, value } or null when the file has no front
 * matter or no version key — both of which are reported, never silently fixed.
 */
export function findVersionLine(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return null; // end of front matter, no version key
    const m = /^(\s+)version:\s*(["']?)([^"'\n]*)\2\s*$/.exec(lines[i]);
    if (m) return { line: i, indent: m[1], quote: m[2], value: m[3] };
  }
  return null;
}

/** What every SKILL.md should say. */
export function packageVersion(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** [{ file, found, value, ok }] — pure read, no writes. */
export function auditSkillVersions(root = ROOT) {
  const want = packageVersion(root);
  return SKILL_MD_FILES.map(rel => {
    const hit = findVersionLine(readFileSync(path.join(root, rel), 'utf8'));
    return {
      file: rel,
      found: !!hit,
      value: hit ? hit.value : null,
      ok: !!hit && hit.value === want,
      want,
    };
  });
}

function sync({ check }) {
  const want = packageVersion();
  let drift = 0;
  for (const rel of SKILL_MD_FILES) {
    const abs = path.join(ROOT, rel);
    const text = readFileSync(abs, 'utf8');
    const hit = findVersionLine(text);
    if (!hit) {
      process.stderr.write(`✗ ${rel}: no metadata.version line in the front matter\n`);
      drift++;
      continue;
    }
    if (hit.value === want) {
      process.stdout.write(`✓ ${rel} — ${want}\n`);
      continue;
    }
    drift++;
    if (check) {
      process.stderr.write(`✗ ${rel} says ${hit.value}, package.json says ${want}\n`);
      continue;
    }
    const lines = text.split('\n');
    const q = hit.quote || '"';
    lines[hit.line] = `${hit.indent}version: ${q}${want}${q}`;
    writeFileSync(abs, lines.join('\n'));
    process.stdout.write(`✎ ${rel}: ${hit.value} → ${want}\n`);
  }
  if (check && drift) {
    process.stderr.write('\nSKILL.md front matter has drifted from package.json.\n');
    process.stderr.write('Fix: npm run sync:version\n');
    process.exit(1);
  }
  return drift;
}

// Only act when run as a script; the exports above are for test/smoke.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sync({ check: process.argv.includes('--check') });
}
