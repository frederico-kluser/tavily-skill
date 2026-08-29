// Verify the companion `surf-research-skill` CLI is installed and reachable.
//
// We shell out instead of importing — surf-research-skill is a sibling npm package
// the user installs separately, and we want to detect "not installed" rather
// than crash on an import error.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(exec);

/**
 * @returns {Promise<{
 *   installed: boolean,
 *   version?: string,
 *   keyCounts?: { brave: number, braveUsable: number },
 *   error?: string,
 * }>}
 */
export async function checkSurfSkill() {
  try {
    const { stdout: vOut } = await pexec('surf-research-skill --version', { timeout: 10_000 });
    const version = vOut.trim().split('\n').pop();

    let keyCounts;
    try {
      const { stdout: kOut } = await pexec('surf-research-skill keys list --json', { timeout: 10_000 });
      const state = JSON.parse(kOut);
      const keys = Array.isArray(state?.brave?.keys) ? state.brave.keys.length : 0;
      const burned = Array.isArray(state?.brave?.burned) ? state.brave.burned.length : 0;
      // Report USABLE, not total. A burned-only install has keys and cannot
      // search, and reporting the raw count made doctor call that healthy.
      keyCounts = { brave: keys, braveUsable: Math.max(0, keys - burned) };
    } catch {
      // keys list --json may fail (older surf-research-skill); ignore.
    }

    return { installed: true, version, keyCounts };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return {
      installed: false,
      error: /not found|ENOENT/i.test(msg) ? 'surf-research-skill not in PATH' : msg,
    };
  }
}
