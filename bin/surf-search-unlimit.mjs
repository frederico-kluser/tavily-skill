#!/usr/bin/env node
// surf-search-unlimit — autonomous research that keeps going until the
// question is actually resolved.
//
// Same machine as surf-search-normal, with the loop opened up: after every
// round the LLM reads the whole harvest, states what is still open, and writes
// the next round's queries. It stops when the analyst says the success
// criteria are met, when it runs out of new questions to ask, or when it hits
// --max-rounds. There is NO self-imposed time deadline, so only run this where
// the harness will let a long command finish (Pi core, or a Bash call you gave
// an explicit long timeout).

import { parseFlags } from '../src/lib/flags.mjs';
import { setSilent } from '../src/lib/progress.mjs';
import { runAiCommand, reportAiError } from '../src/lib/ai/cli.mjs';
import { migrateLegacy } from '../src/lib/state.mjs';
import { preflightOrExit } from '../src/lib/preflight.mjs';
// Single source of the version number: src/lib/version.mjs reads package.json.
import { VERSION } from '../src/lib/version.mjs';

const HELP = `surf-search-unlimit — autonomous web research, AS MANY ROUNDS AS NEEDED

Usage:
  surf-search-unlimit "<question>" [flags]

Loop:  plan → wave of sub-agents → gap analysis → descend into the thin
       branches → … → answer

Follow-ups are tree nodes: each one records the query whose RESULT provoked it
and how deep it sits, so a later wave drills into a thin branch instead of
re-asking the same question wider. Branches close when the analyst says they
are answered or when two waves in a row add no new sources.

Stops when the analyst reports the question resolved, when the sources
saturate, when every branch is closed, or at --max-rounds.

The brief (all optional, all worth writing):
  --task "<what you are building/doing right now>"
  --goal "<what you need out of this research>"
  --insights "<what you already believe — it gets verified, not assumed>"
  --deliverable "<the exact shape of answer you want back>"
  --brief-file <f.json>  {"question","task","goal","insights","deliverable"}

Tuning:
  --max-rounds N      wave cap (default 6, hard cap 50)
  --sub-agents N      simultaneous searches (default 10, max 20; also
                      --sub-agents=N). ONE budget: it is both the wave width
                      and the worker-pool width. surf reads your Brave plan's
                      real requests-per-second from the API's own headers and
                      paces the wave to it, so a number above what the plan
                      allows queues rather than fails.
  --concurrency N     deprecated alias for --sub-agents
  --max-queries N     frontier admissions per wave (>= --sub-agents)
  --max-depth N       how far a branch may descend (default 3, max 6)
  --max N             results per search (1-20). Overrides --search-mode.
  --search-mode <fast|normal|slow>   results per query: 5 / 10 / 20
  --ai-model <slug>   override the LLM (default deepseek/deepseek-v4-pro)
  --no-cache            Skip the response cache for this run.

Output:
  --json              structured envelope (plan, ledger, sources, diagnostics)
  --ledger            append the per-query coverage table
  --out <file>        also write the answer to a file
  --quiet             silence the stderr progress log
  --help, -h · --version, -v

⚠ No time budget is enforced. On a harness with a bash timeout, either raise it
  (surf-research-skill project-config), give the Bash call an explicit long
  timeout, or use surf-search-normal instead. Note that Brave paces requests to
  your plan's rate limit, so a wide fan-out on a 1 req/s plan takes real time.

Exit codes:  0 ok · 1 nothing retrieved · 2 usage error · 78 no valid Brave key

Setup (once):  surf              # Brave key + OpenRouter key, both validated
               surf-research-skill ai-setup     # just the OpenRouter key
Docs:          ~/.agents/skills/surf-research-agent-skill/SKILL.md
`;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    process.stderr.write(
      `❌ Error [KilledBySignal]: surf-search-unlimit received ${sig} — the harness killed a long run. ` +
      `Raise this project's bash timeout with 'surf-research-skill project-config', ` +
      `give the Bash call an explicit long timeout, or use 'surf-search-normal'.\n`
    );
    process.exit(143);
  });
}

const [, , ...argv] = process.argv;

if (argv.length === 0) {
  process.stdout.write(HELP);
  process.exit(2);
}

// --help/-h/--version are recognised ANYWHERE in the option head, not only at
// argv[0]: `--json --help` must print help regardless of argument order. This
// runs BEFORE parseFlags and BEFORE the Brave key gate, so asking for help
// never requires a working configuration. The `--` end-of-options separator
// still shields a query that merely reads like a flag.
const optHeadLen = argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--');
const optHead = argv.slice(0, optHeadLen);
if (optHead.includes('--help') || optHead.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (optHead.includes('--version') || optHead.includes('-v')) {
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
  const code = await runAiCommand({ pos, flags, mode: 'unlimit' });
  process.exit(code);
} catch (e) {
  process.exit(reportAiError(e));
}
