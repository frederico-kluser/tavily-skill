#!/usr/bin/env node
// surf-search-normal — one autonomous research round, guaranteed to fit inside
// the calling agent's bash timeout.
//
// The CLI does everything: an LLM (DeepSeek via OpenRouter) turns your brief
// into a category-diverse query set, up to --sub-agents of them run at once
// against Brave Search (paced to your plan's real rate limit), and the LLM
// writes the final cited answer in the shape you asked for. Rate limits, key
// rotation, unavailable models and failed searches are absorbed in here.
//
// The one thing NOT absorbed is a missing or invalid Brave key: that exits 78
// before any work starts. v8 answers from Brave or says why it cannot — it
// never quietly answers from somewhere else.
//
// Need more than one round? Use `surf-search-unlimit`.

import { parseFlags } from '../src/lib/flags.mjs';
import { setSilent } from '../src/lib/progress.mjs';
import { runAiCommand, reportAiError } from '../src/lib/ai/cli.mjs';
import { migrateLegacy } from '../src/lib/state.mjs';
import { preflightOrExit } from '../src/lib/preflight.mjs';
// Single source of the version number: src/lib/version.mjs reads package.json.
import { VERSION } from '../src/lib/version.mjs';

const HELP = `surf-search-normal — autonomous web research, ONE round

Usage:
  surf-search-normal "<question>" [flags]

The brief (all optional, all worth writing — they are what make the answer
usable instead of generic):
  --task "<what you are building/doing right now>"
  --goal "<what you need out of this research>"
  --insights "<what you already believe — it gets verified, not assumed>"
  --deliverable "<the exact shape of answer you want back>"
  --brief-file <f.json>  {"question","task","goal","insights","deliverable"}

Tuning:
  --sub-agents N      simultaneous searches (default 10, max 20; also
                      --sub-agents=N). ONE budget: it is both the wave width
                      and the worker-pool width. surf reads your Brave plan's
                      real requests-per-second from the API's own headers and
                      paces the wave to it, so a number above what the plan
                      allows queues rather than fails.
  --concurrency N     deprecated alias for --sub-agents
  --max-queries N     frontier admissions per wave (>= --sub-agents)
  --max-depth N       how far a branch may descend (default 2, max 6)
  --max N             results per search (1-20). Overrides --search-mode.
  --search-mode <fast|normal|slow>   results per query: 5 / 10 / 20
  --ai-model <slug>   override the LLM (default deepseek/deepseek-v4-pro)
  --budget-ms N         Override the self-budget (0 = unlimited). Also SURF_AI_BUDGET_MS.
  --no-cache            Skip the response cache for this run.

Output:
  --json              structured envelope (plan, ledger, sources, diagnostics)
  --ledger            append the per-query coverage table
  --out <file>        also write the answer to a file
  --quiet             silence the stderr progress log
  --help, -h · --version, -v

One wave, by design: the whole run is fitted inside the harness's detected
bash timeout, so it returns an answer instead of being killed mid-flight.
For real deepening (analyze the harvest, descend, repeat) use:
  surf-search-unlimit "<question>"

Exit codes:  0 ok · 1 nothing retrieved · 2 usage error · 78 no valid Brave key

Setup (once):  surf              # Brave key + OpenRouter key, both validated
               surf-research-skill ai-setup     # just the OpenRouter key
Docs:          ~/.agents/skills/surf-research-agent-skill/SKILL.md
`;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    process.stderr.write(
      `❌ Error [KilledBySignal]: surf-search-normal received ${sig}. ` +
      `Raise this project's bash timeout with 'surf-research-skill project-config', ` +
      `or run the Bash call with a longer timeout.\n`
    );
    process.exit(143);
  });
}

const [, , ...argv] = process.argv;

if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
  process.stdout.write(HELP);
  process.exit(argv.length === 0 ? 2 : 0);
}
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}

await migrateLegacy();

let pos, flags;
try {
  ({ pos, flags } = parseFlags(argv));
} catch (e) {
  process.stderr.write(`❌ Error: ${e.message}\n`);
  process.exit(2);
}
if (flags.quiet) setSilent(true);

// Halt here, before the LLM plans anything, if there is no valid Brave key.
// Validating costs nothing (a q-less request is rejected before it is billed)
// and the verdict is cached for a week, so this is milliseconds in the common
// case — and it is the difference between an honest exit 78 and a confident
// answer assembled from nothing.
await preflightOrExit();

try {
  const code = await runAiCommand({ pos, flags, mode: 'normal' });
  process.exit(code);
} catch (e) {
  process.exit(reportAiError(e));
}
