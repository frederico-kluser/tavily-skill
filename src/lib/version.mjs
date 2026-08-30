// The ONE place this package learns its own version number.
//
// Before this file existed the string '8.0.0' was retyped in seven places —
// four `const VERSION` in bin/, one in dispatch.mjs (which stamps it onto the
// `X-Client-Name` header of EVERY Brave request), one in the validators, one
// dead one in the orchestrator — plus the postinstall banner. package.json had
// already moved to 8.0.1, and one bin had been bumped by hand, so the package
// disagreed with itself. Every one of those sites now imports from here, and
// here reads package.json. Bumping package.json is the whole release edit.
//
// WHY A FILE READ AND NOT `import pkg from '../../package.json' with { type: 'json' }`:
// import attributes are Node >=20.10 (and the older `assert` spelling was
// removed), while package.json says `"engines": { "node": ">=18" }`. A JSON
// import would turn every `surf --version` on a Node 18 LTS install into a
// SyntaxError at MODULE LOAD — before any code of ours runs, so nothing could
// catch it. `fs.readFileSync(URL)` has accepted a `file:` URL since Node 7 and
// is the same API on 18, 20, 22 and 24.
//
// WHY `new URL('../../package.json', import.meta.url)` AND NOT process.cwd():
// the path is resolved against THIS MODULE, so it lands on the package root
// whether we are running from a dev checkout, from a global
// `node_modules/surf-agent-skill/`, or through one of the harness symlinks
// (Node resolves the realpath before setting import.meta.url). cwd is wherever
// the user happened to be standing and would be wrong in all three.
//
// WHY IT NEVER THROWS: a `--version` that crashes because a file moved is
// strictly worse than a `--version` that prints something honest-but-vague —
// and this module is imported by dispatch, so a throw here would take down
// every search, not just the version flag. Both the read and the parse are
// guarded and degrade to UNKNOWN_VERSION.
//
// COST: one ~4 KB readFileSync, once per process (ESM caches the module), on a
// file npm itself just read. Against ~30 ms of Node startup it does not
// register.

import { readFileSync } from 'node:fs';

/**
 * What we report when package.json cannot be read or parsed.
 *
 * Deliberately a well-formed semver-with-prerelease rather than '' or
 * 'unknown':
 *   · `X-Client-Name: surf-agent-skill/0.0.0-unknown` is still a valid header
 *     value, so a broken install degrades to a WEIRD client name, never to a
 *     malformed request;
 *   · check-surf-skill.mjs parses `surf-research-skill --version` with
 *     /^v?\d+\.\d+\.\d+/, so the doctor still recognises it as a version line
 *     instead of falling back to "whatever the first line was";
 *   · 0.0.0 sorts below every real release, so any "is it new enough?" check
 *     answers "no", which is the safe answer;
 *   · and the `-unknown` tag makes it unmistakably not a published version.
 */
export const UNKNOWN_VERSION = '0.0.0-unknown';

function readPkg() {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw);
    return (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) ? pkg : null;
  } catch {
    return null;
  }
}

const PKG = readPkg();

/** This package's version, straight from package.json. */
export const VERSION =
  (PKG && typeof PKG.version === 'string' && PKG.version.trim())
    ? PKG.version.trim()
    : UNKNOWN_VERSION;

/**
 * The executables package.json actually installs, in declaration order.
 *
 * Same reasoning as VERSION: the postinstall banner used to hand-count them
 * ("5 bins") right next to a hand-counted "2 skills" that was wrong by the
 * time anyone read it. Empty only when package.json could not be read.
 */
export const BIN_NAMES =
  (PKG && PKG.bin && typeof PKG.bin === 'object' && !Array.isArray(PKG.bin))
    ? Object.keys(PKG.bin)
    : [];

/** True when the version above is a real reading and not the degraded default. */
export const VERSION_KNOWN = VERSION !== UNKNOWN_VERSION;

export default VERSION;
