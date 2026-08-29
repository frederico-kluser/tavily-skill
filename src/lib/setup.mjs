// Interactive onboarding wizard. Requires a TTY. Non-TTY callers should use
// `surf-research-skill keys add` directly.
//
// Two providers, and only one of them searches:
//   Brave      — the search backend. Without a valid key nothing runs at all.
//   OpenRouter — the LLM that plans, analyzes and writes the answer.
// Adding a second Brave key is not redundancy for its own sake: each key has
// its own per-second rate budget, so two keys genuinely double the fan-out.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadState, saveStateAtomic, KEYS_FILE } from './state.mjs';
import { validateKey, formatValidation } from '../validators/index.mjs';
import { PRIMARY_MODEL } from './ai/openrouter.mjs';

const BANNER = `
┌─ surf setup ─────────────────────────────────────────────────────
│ Two keys. You can add several of each (Enter empty to finish a
│ provider; Enter twice in a row to skip it).
│
│ SEARCH — Brave, and only Brave. REQUIRED: without a valid Brave
│ key every research command stops with exit 78 rather than
│ answering from somewhere else.
│   Brave:  https://api-dashboard.search.brave.com
│           $5/1,000 requests, with ~$5 of credit applied monthly.
│           Adding a SECOND key is not redundancy — each key carries
│           its own per-second rate budget, so two keys double how
│           many sub-agents can search at the same time.
│
│ LLM — OpenRouter. Powers the planning, the gap analysis and the
│ final synthesis. Without it surf still searches, but hands back
│ raw evidence instead of an answer.
│   OpenRouter: https://openrouter.ai/keys                (default: ${PRIMARY_MODEL})
│
│ Both are validated live before being saved, and both validations
│ are FREE — no credits, no quota, no tokens.
│
│ Keys live in ${KEYS_FILE} (chmod 600).
└──────────────────────────────────────────────────────────
`;

const CHEAT_SHEET_TPL = (counts) => `
✓ Saved. Now have ${counts.brv} Brave key${counts.brv === 1 ? '' : 's'}, ${counts.orr} OpenRouter key${counts.orr === 1 ? '' : 's'}.

${counts.brv ? '' : `⚠ NO BRAVE KEY. Every research command will stop with exit 78 until
  you add one — surf has no other search backend and no free tier
  underneath. Fix: surf-research-skill keys add --provider brave <key>
`}${counts.orr ? `surf-ai is ON. Start here:
  surf-search-normal "your question" --task "…" --goal "…" --insights "…"
  surf-search-unlimit "your question" --sub-agents=10 --max-depth 3
` : `⚠ No OpenRouter key — surf-ai will search but not synthesize.
  Turn it on: surf-research-skill ai-setup
`}
Plain search commands:
  surf-research-skill search "your query"
  surf-research-skill search "q1" "q2" "q3"                # batch (N queries)
  surf-research-skill search "x" --mode fast --domains docs.rs
  surf-research-skill search-parallel "a" "b" "c" --sub-agents=6
  surf-research-skill keys list

Add another key later with:
  surf-research-skill keys add --provider <brave|openrouter> <key>

🛠  IMPORTANT — in each project where you'll use surf-research-skill, run:
      surf-research-skill project-config
   This raises the per-project bash timeout for the harness in that repo.

⚠  GitHub Copilot CLI users: this step is REQUIRED. Copilot's default bash
   timeout is 30s and surf-research-skill needs more (most commands run 3–60s).

Docs: SKILL.md  ·  Repo: https://github.com/frederico-kluser/surf-agent-skill
`;

async function promptKeys(rl, provider, existing = []) {
  const collected = [];
  let i = 1;
  const seen = new Set(existing);
  while (true) {
    const promptText = i === 1
      ? `${provider} key #${i} (Enter to skip ${provider}): `
      : `${provider} key #${i} (Enter to finish, or paste another): `;
    let ans = '';
    try {
      ans = (await rl.question(promptText)).trim();
    } catch {
      break;
    }
    if (!ans) break;
    if (seen.has(ans)) {
      stdout.write(`  (already configured, skipping)\n`);
      continue;
    }
    collected.push(ans);
    seen.add(ans);
    i++;
  }
  return collected;
}

export async function runSetup() {
  if (!stdin.isTTY) {
    const err = new Error(`'setup' requires a TTY. Use:
  surf-research-skill keys add --provider brave <key>          # REQUIRED
  surf-research-skill keys add --provider openrouter <key>     # powers surf-ai
  surf-research-skill ai-setup --key <key>                     # same, with guidance`);
    err.code = 'NO_TTY';
    throw err;
  }

  stdout.write(BANNER);

  const state = await loadState();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let newBrv = [];
  let newOrr = [];
  try {
    newBrv = await promptKeys(rl, 'Brave', state.brave.keys);
    stdout.write('\n');
    newOrr = await promptKeys(rl, 'OpenRouter', state.openrouter.keys);
  } finally {
    rl.close();
  }

  if (!newBrv.length && !newOrr.length) {
    stdout.write('\nNo new keys provided. Rerun with: surf-research-skill setup\n');
    return { addedBrave: 0, addedOpenRouter: 0 };
  }

  // Live-validate every freshly collected key before persisting. Invalid
  // keys are dropped from the batch with a clear message. The user
  // doesn't waste hours wondering why fallback isn't kicking in.
  stdout.write('\n— Validating new keys (free: no credits, no quota, no tokens) —\n');
  const keptBrv = [];
  for (const k of newBrv) {
    stdout.write(`  brave ${k.slice(0, 5)}…${k.slice(-4)} → `);
    const r = await validateKey('brave', k);
    stdout.write(formatValidation(r) + '\n');
    if (r.valid) keptBrv.push(k);
  }
  // OpenRouter validates via free key introspection — no credit, no tokens.
  // Brave (above) validates via a deliberately invalid request, which the API
  // rejects before billing it. Neither costs anything.
  const keptOrr = [];
  for (const k of newOrr) {
    stdout.write(`  openrouter ${k.slice(0, 8)}…${k.slice(-4)} → `);
    const r = await validateKey('openrouter', k);
    stdout.write(formatValidation(r) + '\n');
    if (r.valid) keptOrr.push(k);
  }
  const dropped = (newBrv.length - keptBrv.length) + (newOrr.length - keptOrr.length);
  if (dropped) {
    stdout.write(`\n⚠ ${dropped} key${dropped === 1 ? '' : 's'} failed validation and were NOT saved.\n`);
  }
  if (!keptBrv.length && !keptOrr.length) {
    stdout.write('\nNo valid keys to save. Re-run `surf-research-skill setup` with working keys.\n');
    return { addedBrave: 0, addedOpenRouter: 0, dropped };
  }

  for (const k of keptBrv) state.brave.keys.push(k);
  for (const k of keptOrr) state.openrouter.keys.push(k);
  for (const p of ['brave', 'openrouter']) {
    if (state[p].keys.length && state[p].current >= state[p].keys.length) state[p].current = 0;
  }

  await saveStateAtomic(state);

  stdout.write(CHEAT_SHEET_TPL({
    brv: state.brave.keys.length,
    orr: state.openrouter.keys.length,
  }));
  return {
    addedBrave: keptBrv.length,
    addedOpenRouter: keptOrr.length,
    dropped,
  };
}
