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
// That rule binds BOTH deleting entry points — uninstallSkill()/unlinkIfOurs()
// AND cleanupLegacy(). A name alone is never proof of ownership.

import { constants as FS, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, blankProvider } from './state.mjs';

const home = os.homedir();

// This file lives at <pkgRoot>/src/lib/harness-install.mjs, so two levels up is
// the package root — the same expression postinstall.mjs and preuninstall.mjs
// compute from their own module URL. cleanupLegacy() takes no arguments (both
// lifecycle scripts call it bare), so it has to derive the root it is allowed
// to delete links INTO, rather than be told.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every npm name this project has ever published. A legacy link made by an
// older release points into `<node_modules>/<one of these>`; nothing else on
// the machine does. `tavily` is deliberately NOT here: it is a legacy SKILL
// name of ours but also a real, unrelated npm package — a link pointing at
// `<node_modules>/tavily` belongs to whoever installed that, not to us.
const OUR_PACKAGE_NAMES = ['surf-agent-skill', 'surf-skill'];

// Harness skill directories (per published docs as of 2026-05).
// Order: canonical first, then per-harness.
export const HARNESS_DIRS = [
  path.join(home, '.agents', 'skills'),       // OpenCode + GH Copilot CLI canonical
  path.join(home, '.claude', 'skills'),       // Claude Code
  path.join(home, '.codex', 'skills'),        // OpenAI Codex CLI
  path.join(home, '.pi', 'agent', 'skills'),  // Pi Coding Agent
];

// Legacy skill names whose stale symlinks are removed on upgrade so they don't
// shadow the current ones — but ONLY the ones we can prove we created (see
// cleanupLegacy). These are names, not evidence: half of them are ordinary
// words a user may well have used for a skill of their own, `tavily` most of
// all, and `surf` is a bare noun. Matching the name is where the search starts,
// never where the deletion is decided.
// Includes:
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

// The ONE proof of ownership in this file, used by BOTH deleting paths.
// Answers "what does this link provably point AT, if we made it?" and returns
// null the moment it cannot answer:
//   - not a symlink at all (a user's real dir or copy) — never ours;
//   - a RELATIVE stored target — symlinkOrCopy() is only ever called with an
//     absolute target, so by construction a relative link is not ours. This is
//     also the guard that makes the answer independent of process.cwd(): npm
//     parks lifecycle scripts in an unrelated directory, and a relative target
//     resolved against THAT is how a user's own link got deleted before;
//   - unreadable.
// Otherwise the target is resolved the way the kernel resolves it (linkTarget).
// Callers decide the SCOPE the target has to fall in; nobody re-derives the
// proof itself.
async function provenLinkTarget(link) {
  let stat;
  try { stat = await fs.lstat(link); } catch { return null; }
  if (!stat.isSymbolicLink()) return null;
  let stored;
  try { stored = await fs.readlink(link); } catch { return null; }
  if (stored === null || !path.isAbsolute(stored)) return null;
  return linkTarget(link, stored);
}

// Is `p` the directory `root`, or something inside it? Pure path arithmetic —
// it never touches the filesystem, which is exactly why it also works for a
// link whose target no longer exists (the commonest legacy shape of all).
function isInside(root, p) {
  const r = path.resolve(root);
  const q = path.resolve(p);
  if (q === r) return true;
  const rel = path.relative(r, q);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A target inside an npm install of a package name THIS project published:
// `<anything>/node_modules/surf-agent-skill/...` or `.../node_modules/surf-skill/...`.
// Needed because the npm package was renamed (surf-skill → surf-agent-skill),
// so links left by v7-and-earlier point at a sibling directory, not into the
// root we are running from. `node_modules/` in the parent position is what
// keeps this from matching a user directory that merely shares the name.
function insideOurInstall(p) {
  let cur = path.resolve(p);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    if (OUR_PACKAGE_NAMES.includes(path.basename(cur)) &&
        path.basename(parent) === 'node_modules') return true;
    cur = parent;
  }
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
    // Scope: EXACT. This name is one we install right now, so we know the one
    // path it may point at.
    const target = await provenLinkTarget(link);
    if (target === null) return false;
    if (target !== path.resolve(expectedTarget)) return false;
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
//   - surf-search-agent-skill   → pkgRoot/skills/surf-search-agent-skill/ (the SHALLOW half of the
//                                                                   research pair: ONE independent
//                                                                   question, one surf-search-normal
//                                                                   call, no sub-agents and nothing
//                                                                   written to disk)
//
// Each harness gets one symlink per skill (e.g. ~/.claude/skills/surf-research-agent-skill,
// …/surf-plan-agent-skill, …/surf-search-agent-skill; same for .agents/.codex/.pi).
//
// EXPORTED because two other places need the same list and both were deriving
// it the hard way: `surf doctor` (bin/surf.mjs, canonicalSkillNames) used to
// regex this literal out of THIS FILE'S SOURCE, and the postinstall banner
// hand-counted it — and announced "2 skills" for a while after the third one
// shipped. Exporting is pure addition: shape and contents are untouched, and
// it retires the source-scraping fallback.
export const SKILLS = [
  { name: 'surf-research-agent-skill', subdir: null },                            // root of package
  { name: 'surf-plan-agent-skill',     subdir: 'skills/surf-plan-agent-skill' },
  { name: 'surf-search-agent-skill',   subdir: 'skills/surf-search-agent-skill' },
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

// Remove the stale symlinks OUR OWN earlier releases left under LEGACY_NAMES.
//
// A legacy name is where the search starts, never where the deletion is
// decided. `tavily`, `surf`, `surf-plan` are plain words; a user with a skill
// of their own under one of them used to lose it on every install — and, since
// the preuninstall sweep, on every uninstall too. Same defect unlinkIfOurs()
// was fixed for, reached through the second entry point.
//
// A link is deleted only when provenLinkTarget() answers (absolute symlink,
// resolved dirname-relative like the kernel does it) AND that target lands
//   - inside the package root we are running from (PKG_ROOT), or
//   - inside an npm install of a package name this project published.
//
// "Ours and BROKEN" vs "theirs and broken" — the case that matters most, since
// a legacy link usually dangles (the binary behind it was deleted in v8):
// the test is on the PATH the link stores, never on what is at the end of it,
// so a dead link is judged exactly like a live one. `surf-free-agent-skill ->
// <PKG_ROOT>/skills/surf-free-agent-skill` is provably ours whether or not that
// directory still exists; a dead link into the user's own tree is provably not.
// Anything we cannot prove is KEPT and reported (results.kept, plus one line on
// stdout), because losing a cleanup is recoverable and losing their file is not.
//
// A real directory or file wearing a legacy name is never a candidate: it is
// not a symlink, so provenLinkTarget() refuses it and nothing is unlinked.
export async function cleanupLegacy() {
  const results = [];
  const kept = [];
  // Non-enumerable so `for (const r of results)` in postinstall/preuninstall
  // still sees removals only — the array's contract is unchanged.
  Object.defineProperty(results, 'kept', { value: kept, enumerable: false });
  for (const dir of HARNESS_DIRS) {
    for (const name of LEGACY_NAMES) {
      const link = path.join(dir, name);
      // Use lstat (not existsSync) so we also catch broken symlinks pointing
      // at paths that no longer exist (e.g. from a removed prior install).
      try {
        const stat = await fs.lstat(link);
        if (stat.isSymbolicLink()) {
          const target = await provenLinkTarget(link);
          const ours = target !== null &&
                       (isInside(PKG_ROOT, target) || insideOurInstall(target));
          if (!ours) {
            kept.push({ kept: link, target, reason: 'not ours' });
            // The one thing a user cannot see for themselves: we found a link
            // wearing one of our old names and deliberately did NOT touch it.
            // Guarded — a dead stdout must never cost the rest of the sweep.
            try {
              process.stdout.write(
                `ℹ kept ${link} — not ours (it does not point into this package)\n`);
            } catch {}
            continue;
          }
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
