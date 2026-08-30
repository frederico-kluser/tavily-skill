// Cross-OS skill registration helpers used by postinstall / preuninstall.
//
// Strategy:
//   - Symlink the package root into each harness's skill dir
//     (~/.claude/skills/<skill-name>, ~/.agents/skills/<skill-name>, etc.)
//   - On Windows: try fs.symlink with type='junction' first (no admin needed
//     for directories). If EPERM/ENOSYS, fall back to recursive copy.
//   - Idempotent: re-running fixes stale symlinks — including BROKEN ones,
//     which is the state `npm i -g` leaves behind after a node version swap —
//     and leaves user copies alone.
//
// Safety rule that governs this whole file: we only ever DELETE a path we can
// prove we created. Every link we create is an absolute symlink; anything
// relative, or pointing anywhere but at our package, belongs to the user.

import { constants as FS, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, blankProvider } from './state.mjs';

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

// Resolve what a symlink actually points AT, the way the kernel does it: an
// absolute stored target as itself, a relative one against the directory the
// LINK lives in. Bare path.resolve() would resolve it against process.cwd(),
// which is wherever npm happened to park the lifecycle script — a completely
// unrelated directory.
function linkTarget(link, stored) {
  return path.isAbsolute(stored)
    ? path.resolve(stored)
    : path.resolve(path.dirname(link), stored);
}

export async function symlinkOrCopy(target, link) {
  // lstat, NOT existsSync: existsSync FOLLOWS the link, so a broken symlink
  // answered `false`, skipped the repair branch below, and fell through to
  // fs.cp — which throws EISDIR/ERR_FS_CP_DIR_TO_NON_DIR. A dangling link is
  // precisely what a moved/renamed prior install leaves behind, so it is the
  // most common input this function gets, and it must be repairable.
  let stat = null;
  try {
    stat = await fs.lstat(link);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Something is there but unreadable/corrupt — try to clear it.
      try { await fs.rm(link, { recursive: true, force: true }); } catch {}
    }
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      let cur = null;
      try { cur = await fs.readlink(link); } catch {}
      if (cur !== null && linkTarget(link, cur) === path.resolve(target)) {
        return { action: 'kept-symlink' };
      }
      await fs.unlink(link);
    } else {
      // User has a non-symlink there (probably their own copy). Leave alone.
      return { action: 'preserved-existing' };
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

// Remove `link` ONLY if we can prove we created it. Returns true iff removed.
//
// The old test was `path.resolve(cur) === path.resolve(expectedTarget)`, and
// path.resolve() resolves a relative stored target against process.cwd() — not
// against dirname(link), which is how the kernel resolves it. From the wrong
// cwd, `surf-research-agent-skill -> their-notes` (the USER's own directory,
// living beside the link) resolved onto our package path and got DELETED by an
// uninstall. Two guards close that hole:
//   1. the stored target must be ABSOLUTE — symlinkOrCopy is only ever called
//      with an absolute target, so every link we create is absolute and a
//      relative one is, by construction, not ours;
//   2. it must resolve (via linkTarget, dirname-based) exactly onto the
//      package path we were asked about.
// Anything we cannot prove is ours is left untouched.
export async function unlinkIfOurs(link, expectedTarget) {
  if (!existsSync(link)) return false;
  try {
    const stat = await fs.lstat(link);
    // Non-symlink: likely a user copy. Don't delete.
    if (!stat.isSymbolicLink()) return false;
    const cur = await fs.readlink(link);
    if (!path.isAbsolute(cur)) return false;
    if (linkTarget(link, cur) !== path.resolve(expectedTarget)) return false;
    await fs.unlink(link);
    return true;
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
    // A harness dir we cannot create or write to is a DIRECTORY-level failure:
    // report it once and move on to the next harness. It must never cost the
    // other harnesses, and it must not be reported once per skill.
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, FS.W_OK);
    } catch (e) {
      results.push({ dir, action: 'error', error: e.message });
      continue;
    }
    for (const s of SKILLS) {
      const target = s.subdir ? path.join(pkgRoot, s.subdir) : pkgRoot;
      const link = path.join(dir, s.name);
      try {
        const r = await symlinkOrCopy(target, link);
        results.push({ dir: link, skill: s.name, ...r });
      } catch (e) {
        // One skill's failure must not abort the OTHER skills in the same dir:
        // both used to share a single try, so a single bad link left the
        // second skill uninstalled in that harness.
        results.push({ dir: link, skill: s.name, action: 'error', error: e.message });
      }
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
        // Best effort, never fatal. postinstall.mjs runs cleanupLegacy() FIRST,
        // so rethrowing EACCES from one unreadable/locked harness dir aborted
        // the whole postinstall and the three healthy dirs got nothing. ENOENT
        // is the normal case (the legacy name simply isn't there); anything
        // else (EACCES, EPERM, ENOTDIR, ELOOP) means this one name in this one
        // dir is out of reach, so skip it and keep going.
        continue;
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
    // blankProvider() is the ONE definition of a provider section (state.mjs).
    // The inline literal that used to live here drifted: it was missing
    // `validated`, the exact shape trap keys-cmd.mjs:208 documents.
    for (const p of PROVIDERS) {
      skeleton[p] = blankProvider();
    }
    await fs.writeFile(file, JSON.stringify(skeleton, null, 2) + '\n');
    if (process.platform !== 'win32') {
      try { await fs.chmod(file, 0o600); } catch {}
    }
    return { created: file };
  }
  return { existed: file };
}
