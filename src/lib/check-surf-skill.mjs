// Verify the companion `surf-research-skill` CLI is installed and reachable.
//
// We shell out instead of importing — surf-research-skill is a sibling npm package
// the user installs separately, and we want to detect "not installed" rather
// than crash on an import error.
//
// WHY THIS FILE NO LONGER DECIDES WHAT "USABLE" MEANS
// ---------------------------------------------------
// It used to. `braveUsable` was `keys.length - burned.length`: a subtraction of
// two array LENGTHS, where the gate every real search goes through does an
// intersection of SETS. Two implementations of one concept always drift, and
// these drifted in BOTH directions:
//
//   * A burn record for an index that no longer exists (a key was removed), or
//     two burn records for the SAME index, subtracted more keys than were
//     actually burned. A healthy install reported 0 usable, and
//     `surf-plan-skill doctor` then set exit 78 on a machine that searches
//     fine. Sibling orchestrators treat that 78 as a hard stop, so a false one
//     kills a whole run for no reason.
//   * It never looked at `validated` or `cooldowns`, so a key already PROVEN
//     invalid, or one sitting out a 429 cooldown, was counted as good. The
//     doctor printed green and the next search exited 78 anyway.
//
// So the doctor stopped having an opinion. It asks `gateStatus()` — the same
// function `assertProviderReady()` calls before every dispatch — and reports
// that verdict. There is exactly one definition of "usable Brave key" in this
// package, and it lives in preflight.mjs.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { gateStatus, GATE } from './preflight.mjs';
import { SEARCH_PROVIDER } from './providers/index.mjs';

const pexec = promisify(exec);

// The only two verdicts under which the gate lets a search through. Everything
// else (missing / burned / cooling / invalid) means the next command exits 78.
const GATE_USABLE = new Set([GATE.READY, GATE.UNVALIDATED]);

/**
 * `keys list --json` is masked, and may come from an older build that predates
 * one of these arrays. gateStatus indexes into all of them, so normalise first
 * rather than let a missing field throw and silently drop keyCounts.
 */
function normalizeSection(p) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    keys: arr(p && p.keys),
    current: Number.isInteger(p && p.current) ? p.current : 0,
    burned: arr(p && p.burned),
    cooldowns: arr(p && p.cooldowns),
    validated: arr(p && p.validated),
  };
}

/**
 * The provider section as it would look with ONLY key `i` in it, so the gate
 * can be asked about one key at a time. gateStatus never inspects a key's
 * VALUE — only the index bookkeeping around it — so masked keys are fine here.
 */
function onlyKey(p, i) {
  const pick = (rows) => rows.filter(r => r && r.index === i).map(r => ({ ...r, index: 0 }));
  return {
    keys: [p.keys[i]],
    current: 0,
    burned: pick(p.burned),
    cooldowns: pick(p.cooldowns),
    validated: pick(p.validated),
  };
}

/**
 * The first line that actually looks like a version. This used to be `.pop()`,
 * which takes the LAST line — so an update notice printed after the version
 * ("a newer version is available") became "the installed version".
 */
function parseVersion(stdout) {
  const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /^v?\d+\.\d+\.\d+/.test(l)) || lines[0] || '';
}

/**
 * @returns {Promise<{
 *   installed: boolean,
 *   version?: string,
 *   keyCounts?: { brave: number, braveUsable: number },
 *   gate?: { verdict: string, detail: string },
 *   error?: string,
 * }>}
 */
export async function checkSurfSkill() {
  try {
    const { stdout: vOut } = await pexec('surf-research-skill --version', { timeout: 10_000 });
    const version = parseVersion(vOut);

    let keyCounts;
    let gate;
    try {
      const { stdout: kOut } = await pexec('surf-research-skill keys list --json', { timeout: 10_000 });
      const state = JSON.parse(kOut);
      const p = normalizeSection(state && state[SEARCH_PROVIDER]);

      // ONE authority, asked twice. First: can this machine search at all?
      const verdict = gateStatus({ [SEARCH_PROVIDER]: p }, SEARCH_PROVIDER);
      // Then, the same function per key, for the count the gate does not
      // expose. A key is usable exactly when the gate would accept a ring
      // containing only it.
      const usable = p.keys
        .map((_, i) => i)
        .filter(i => GATE_USABLE.has(gateStatus({ [SEARCH_PROVIDER]: onlyKey(p, i) }, SEARCH_PROVIDER).verdict))
        .length;

      gate = { verdict: verdict.verdict, detail: verdict.detail };
      keyCounts = {
        brave: p.keys.length,
        // `braveUsable === 0` is what makes the doctor exit 78, so it is tied
        // to the gate's own verdict instead of being computed alongside it:
        // the two can never disagree about whether this machine can search.
        braveUsable: GATE_USABLE.has(verdict.verdict) ? Math.max(1, usable) : 0,
      };
    } catch {
      // keys list --json may fail (older surf-research-skill); ignore.
    }

    return { installed: true, version, keyCounts, gate };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // 127 is the shell's "command not found"; ENOENT is spawn failing to reach
    // the shell itself. Both mean "not installed", and neither depends on the
    // shell speaking English — the previous check grepped localized stderr.
    const absent = e && (e.code === 127 || e.code === 'ENOENT' || e.errno === -2);
    return {
      installed: false,
      error: absent ? 'surf-research-skill not in PATH' : msg,
    };
  }
}
