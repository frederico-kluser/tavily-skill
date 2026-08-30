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
//
// AND WHY IT NO LONGER TRANSPORTS THE VERDICT ITSELF EITHER
// --------------------------------------------------------
// Calling gateStatus() killed the second IMPLEMENTATION but left a second
// TRANSPORT: this file read `keys list --json` and then ran the OFFLINE half of
// the gate over it. gateStatus() is offline by construction, and offline it can
// never return UNREACHABLE — the verdict for "the probe got no answer, so the
// key was never judged", which only resolveGate() can reach. On a machine whose
// network is down, holding a key nobody has ever validated, this file therefore
// answered `unvalidated`, `1 usable`, exit 0 — while the very next search ran
// resolveGate(), got UNREACHABLE, and exited 78. Green doctor, dead machine:
// the same class of lie as the subtraction above, one layer up.
//
// The verdict now comes from `surf-research-skill gate --json`, the verb whose
// only job is to produce it (it is in NO_KEYS_NEEDED, so it answers even with
// no key at all, and its payload carries verdict + code + ok + key_count).
// `keys list --json` is still read, but ONLY for the per-key breakdown the gate
// payload does not carry — and that breakdown is clamped to the gate's own
// `ok`, so the count can never claim a key the gate refuses.
//
// WHAT THIS COSTS IN NETWORK
// --------------------------
// `gate` pays for at most ONE live validation, and only when the key has no
// cached verdict — the exact case where no offline answer exists. It costs no
// Brave credit (a q-less request is rejected before it is billed) and the
// verdict is cached for 7 days, so the steady state of this function is ZERO
// requests. It is also the same probe the next real command would have run, so
// the doctor predicts that command instead of guessing. A caller that must not
// touch the network at all sets SURF_DOCTOR_OFFLINE=1 and gets the old offline
// answer, labelled as such in `gate.detail` and `gate.source`.
//
// DEGRADATION: the companion CLI may be older than the `gate` verb. Exit 2 is
// that build saying "unknown command" (usage), NOT "no key" — so it falls back
// to the offline path and says which one it used. It never breaks.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { gateStatus, GATE } from './preflight.mjs';
import { SEARCH_PROVIDER } from './providers/index.mjs';

const pexec = promisify(exec);

// What an OFFLINE look at keys.json is allowed to call usable. UNVALIDATED is
// in here because offline it means "nobody has asked Brave yet", which is not
// evidence against the key. The `gate` verb resolves that ambiguity for real
// (READY / INVALID / UNREACHABLE); this set is only for the fallback path.
const GATE_USABLE_OFFLINE = new Set([GATE.READY, GATE.UNVALIDATED]);

const VERSION_TIMEOUT_MS = 10_000;
const KEYS_TIMEOUT_MS = 10_000;
// Longer than the 20s Brave validator timeout inside `gate`, so a dead network
// makes the CHILD answer UNREACHABLE rather than making us kill it and have to
// guess. See the `killed` branch below for what happens if it hangs anyway.
const GATE_TIMEOUT_MS = 30_000;

/**
 * Run a command and never throw: for these three commands the exit CODE is the
 * information (78 = gate says no, 2 = this build has no such verb), and an
 * exception would throw the stdout away with it.
 */
async function run(cmd, timeout) {
  try {
    const { stdout, stderr } = await pexec(cmd, { timeout });
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '', killed: false, error: null };
  } catch (e) {
    return {
      ok: false,
      code: typeof (e && e.code) === 'number' ? e.code : null,
      stdout: (e && e.stdout) || '',
      stderr: (e && e.stderr) || '',
      killed: !!(e && e.killed),
      error: e || new Error(String(e)),
    };
  }
}

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
 * The `gate --json` payload, or null if this build did not produce one.
 *
 * A build without the verb prints a usage error (exit 2) and no JSON; a build
 * old enough to accept unknown verbs silently prints nothing at all. Both land
 * here as null, and null means "ask the offline path instead" — never "no key".
 */
function readGatePayload(stdout) {
  let p = null;
  try { p = JSON.parse(String(stdout || '')); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (typeof p.verdict !== 'string' || !p.verdict) return null;
  return p;
}

/**
 * @returns {Promise<{
 *   installed: boolean,
 *   version?: string,
 *   keyCounts?: { brave: number, braveUsable: number },
 *   gate?: { verdict: string, detail: string, code: string|null, source: string, probed: boolean },
 *   error?: string,
 * }>}
 */
export async function checkSurfSkill() {
  const v = await run('surf-research-skill --version', VERSION_TIMEOUT_MS);
  if (!v.ok) {
    const e = v.error;
    const msg = (e && e.message) || String(e);
    // 127 is the shell's "command not found"; ENOENT is spawn failing to reach
    // the shell itself. Both mean "not installed", and neither depends on the
    // shell speaking English — the check before this one grepped localized
    // stderr, so a non-English shell got the raw error text instead of a hint.
    const absent = e && (e.code === 127 || e.code === 'ENOENT' || e.errno === -2);
    return {
      installed: false,
      error: absent ? 'surf-research-skill not in PATH' : msg,
    };
  }

  try {
    const version = parseVersion(v.stdout);

    // ---- the per-key breakdown: offline, reads keys.json through the CLI ----
    let section = null;
    const kl = await run('surf-research-skill keys list --json', KEYS_TIMEOUT_MS);
    if (kl.ok) {
      try {
        const state = JSON.parse(kl.stdout);
        section = normalizeSection(state && state[SEARCH_PROVIDER]);
      } catch { section = null; }
    }
    const offline = section ? gateStatus({ [SEARCH_PROVIDER]: section }, SEARCH_PROVIDER) : null;

    // ---- the verdict: the gate verb, which is the authority ----
    const offlineOnly = process.env.SURF_DOCTOR_OFFLINE === '1';
    const verb = offlineOnly ? null : await run('surf-research-skill gate --json', GATE_TIMEOUT_MS);
    const payload = verb ? readGatePayload(verb.stdout) : null;

    let gate = null;
    let usableVerdict = false;
    let payloadCount = null;

    if (payload) {
      // `ok` is the gate's own boolean. Falling back to the offline set when a
      // build omits it keeps an odd payload from reading as "no key".
      usableVerdict = typeof payload.ok === 'boolean'
        ? payload.ok
        : GATE_USABLE_OFFLINE.has(payload.verdict);
      payloadCount = Number.isInteger(payload.key_count) ? payload.key_count : null;
      gate = {
        verdict: payload.verdict,
        detail: payload.detail || '',
        code: payload.code || null,
        source: 'gate --json',
        probed: true,
      };
    } else if (offline) {
      let verdict = offline.verdict;
      let detail = offline.detail || '';
      // WHY THE FALLBACK NAMES ITSELF: `unvalidated` from here and `unvalidated`
      // from the gate verb mean different things — the first is "we did not
      // ask", the second cannot happen. A reader of `surf-plan-skill doctor`
      // sees only verdict + detail, so the reason rides in the detail.
      const why = offlineOnly
        ? 'SURF_DOCTOR_OFFLINE=1'
        : verb && verb.code === 2
          ? 'this surf-research-skill build has no `gate` verb (exit 2)'
          : verb && verb.killed
            ? `\`gate\` did not answer within ${Math.round(GATE_TIMEOUT_MS / 1000)}s`
            : '`gate` produced no verdict';

      // A gate we KILLED told us nothing, and offline `unvalidated` is exactly
      // the state where "nothing" must not read as "fine": that is the false
      // green this whole file exists to stop. Every other offline verdict is a
      // fact about keys.json that resolveGate() would have returned unchanged.
      if (verb && verb.killed && verdict === GATE.UNVALIDATED) {
        verdict = GATE.UNREACHABLE;
        detail = 'the key was never judged';
      }
      usableVerdict = GATE_USABLE_OFFLINE.has(verdict);
      gate = {
        verdict,
        detail: detail ? `${detail} (offline fallback: ${why})` : `offline fallback: ${why}`,
        code: null,
        source: 'keys list --json + gateStatus',
        probed: false,
      };
    }

    let keyCounts;
    if (section || payload) {
      // The same authority, per key, for the count the gate payload does not
      // expose. A key is usable exactly when the gate would accept a ring
      // containing only it.
      const usable = section
        ? section.keys
          .map((_, i) => i)
          .filter(i => GATE_USABLE_OFFLINE.has(gateStatus({ [SEARCH_PROVIDER]: onlyKey(section, i) }, SEARCH_PROVIDER).verdict))
          .length
        : null;
      keyCounts = {
        brave: section ? section.keys.length : (payloadCount || 0),
        // `braveUsable === 0` is what makes the doctor exit 78, so it is tied
        // to the gate's verdict instead of being computed alongside it: the
        // two can never disagree about whether this machine can search.
        braveUsable: usableVerdict ? Math.max(1, usable == null ? 1 : usable) : 0,
      };
    }

    return { installed: true, version, keyCounts, gate: gate || undefined };
  } catch (e) {
    // The CLI answered --version, so it IS installed; anything that throws past
    // here is our own bug and must not be reported as a missing install.
    return {
      installed: true,
      version: parseVersion(v.stdout),
      error: (e && e.message) || String(e),
    };
  }
}
