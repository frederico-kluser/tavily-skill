// Cross-OS skill registration helpers used by postinstall / preuninstall.
//
// Strategy:
//   - Symlink the package root into each harness's skill dir
//     (~/.claude/skills/<skill-name>, ~/.agents/skills/<skill-name>, etc.)
//   - On Windows: try fs.symlink with type='junction' first (no admin needed
//     for directories). If EPERM/ENOSYS, fall back to recursive copy.
//   - Idempotent: re-running fixes stale symlinks, leaves user copies alone.

import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS } from './state.mjs';

const home = os.homedir();

// Harness skill directories (per published docs as of 2026-05).
// Order: canonical first, then per-harness.
export const HARNESS_DIRS = [
  path.join(home, '.agents', 'skills'),       // OpenCode + GH Copilot CLI canonical
  path.join(home, '.claude', 'skills'),       // Claude Code
  path.join(home, '.codex', 'skills'),        // OpenAI Codex CLI
  path.join(home, '.pi', 'agent', 'skills'),  // Pi Coding Agent
];

// Legacy skill names removed on upgrade so stale symlinks don't shadow the
// current ones. Includes:
//   tavily             — pre-rename (before surf-skill)
//   tvly               — short alias from early experiments
//   surf               — `surf` is a CLI binary now; would clash with the bin in PATH
//   surf-skill         — pre-v4 search-skill name (renamed to surf-search-skill, then surf-research-skill)
//   surf-plan          — standalone v1 (folded in as surf-plan-skill in v3+)
//   surf-search-skill  — pre-v5 search-skill name (renamed to surf-research-skill)
//   surf-parallel-skill  — v4.2 parallel-fan-out skill (folded into surf-research-skill in v5)
//   surf-deep-plan-skill — v4.2 ambiguity-sweep skill (folded into surf-plan-skill in v5)
//   surf-free-agent-skill — v7 keyless Wikipedia/DuckDuckGo skill, DELETED in v8.
//     Listed here so upgrading actually removes the stale symlink from all four
//     harness dirs. Leaving it behind would keep advertising a keyless search
//     path whose binary no longer exists.
const LEGACY_NAMES = [
  'tavily', 'tvly', 'surf', 'surf-skill', 'surf-plan',
  'surf-search-skill', 'surf-parallel-skill', 'surf-deep-plan-skill',
  'surf-free-agent-skill',
];

export async function symlinkOrCopy(target, link) {
  // If link already exists, decide whether to replace it.
  if (existsSync(link)) {
    try {
      const stat = await fs.lstat(link);
      if (stat.isSymbolicLink()) {
        const cur = await fs.readlink(link);
        if (path.resolve(cur) === path.resolve(target)) return { action: 'kept-symlink' };
        await fs.unlink(link);
      } else {
        // User has a non-symlink there (probably their own copy). Leave alone.
        return { action: 'preserved-existing' };
      }
    } catch (e) {
      // lstat failed; assume the path is corrupt — try to remove.
      try { await fs.rm(link, { recursive: true, force: true }); } catch {}
    }
  }

  // Try symlink first (junction on Windows works without admin).
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(target, link, type);
    return { action: 'symlinked' };
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'ENOSYS' && e.code !== 'EEXIST') {
      throw e;
    }
    // Fallback: recursive copy (Windows without dev mode).
    await fs.cp(target, link, { recursive: true });
    return { action: 'copied' };
  }
}

export async function unlinkIfOurs(link, expectedTarget) {
  if (!existsSync(link)) return false;
  try {
    const stat = await fs.lstat(link);
    if (stat.isSymbolicLink()) {
      const cur = await fs.readlink(link);
      if (path.resolve(cur) === path.resolve(expectedTarget)) {
        await fs.unlink(link);
        return true;
      }
      return false;
    }
    // Non-symlink: likely a user copy. Don't delete.
    return false;
  } catch {
    return false;
  }
}

// Install ALL skills shipped by this package:
//   - surf-research-agent-skill → pkgRoot                         (root SKILL.md; search, parallel
//                                                                   fan-out, and async deep research,
//                                                                   auto-routed by the skill itself)
//   - surf-plan-agent-skill     → pkgRoot/skills/surf-plan-agent-skill/ (planning workflow; auto-routes
//                                                                   into an ambiguity-sweep mode for
//                                                                   high-stakes/vague work)
//
// Each harness gets one symlink per skill (e.g. ~/.claude/skills/surf-research-agent-skill,
// …/surf-plan-agent-skill; same for .agents/.codex/.pi).
const SKILLS = [
  { name: 'surf-research-agent-skill', subdir: null },                            // root of package
  { name: 'surf-plan-agent-skill',     subdir: 'skills/surf-plan-agent-skill' },
];

export async function installSkill(pkgRoot) {
  const results = [];
  for (const dir of HARNESS_DIRS) {
    try {
      await fs.mkdir(dir, { recursive: true });
      for (const s of SKILLS) {
        const target = s.subdir ? path.join(pkgRoot, s.subdir) : pkgRoot;
        const link = path.join(dir, s.name);
        const r = await symlinkOrCopy(target, link);
        results.push({ dir: link, skill: s.name, ...r });
      }
    } catch (e) {
      results.push({ dir, action: 'error', error: e.message });
    }
  }
  return results;
}

export async function uninstallSkill(pkgRoot) {
  const results = [];
  for (const dir of HARNESS_DIRS) {
    for (const s of SKILLS) {
      const expectedTarget = s.subdir ? path.join(pkgRoot, s.subdir) : pkgRoot;
      const link = path.join(dir, s.name);
      try {
        const removed = await unlinkIfOurs(link, expectedTarget);
        results.push({ dir: link, skill: s.name, removed });
      } catch (e) {
        results.push({ dir: link, skill: s.name, removed: false, error: e.message });
      }
    }
  }
  return results;
}

export async function cleanupLegacy() {
  const results = [];
  for (const dir of HARNESS_DIRS) {
    for (const name of LEGACY_NAMES) {
      const link = path.join(dir, name);
      // Use lstat (not existsSync) so we also catch broken symlinks pointing
      // at paths that no longer exist (e.g. from a removed prior install).
      try {
        const stat = await fs.lstat(link);
        if (stat.isSymbolicLink()) {
          await fs.unlink(link);
          results.push({ removed: link });
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  return results;
}

export async function ensureKeysSkeleton() {
  const cfgDir = path.join(home, '.config', 'surf');
  await fs.mkdir(cfgDir, { recursive: true });
  const file = path.join(cfgDir, 'keys.json');
  if (!existsSync(file)) {
    const skeleton = { schema_version: 1, last_ok_provider: null };
    // openrouter is included: it holds the LLM key that powers surf-ai.
    for (const p of PROVIDERS) {
      skeleton[p] = { keys: [], current: 0, burned: [], cooldowns: [] };
    }
    await fs.writeFile(file, JSON.stringify(skeleton, null, 2) + '\n');
    if (process.platform !== 'win32') {
      try { await fs.chmod(file, 0o600); } catch {}
    }
    return { created: file };
  }
  return { existed: file };
}
