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

const VERSION = '7.0.0';

const HELP = `surf-search-unlimit — autonomous web research, AS MANY ROUNDS AS NEEDED

Usage:
  surf-search-unlimit "<question>" [flags]

Loop:  plan → parallel search → gap analysis → search the gaps → … → answer
Stops when the analyst reports the question resolved, has no further queries,
or --max-rounds is reached.

The brief (all optional, all worth writing):
  --task "<what you are building/doing right now>"
  --goal "<what you need out of this research>"
  --insights "<what you already believe — it gets verified, not assumed>"
  --deliverable "<the exact shape of answer you want back>"
  --brief-file <f.json>  {"question","task","goal","insights","deliverable"}

Tuning:
  --max-rounds N      round cap (default 6, hard cap 50)
  --max-queries N     queries per round (default 10, max 24)
  --concurrency N     parallel searches (default 8, max 16)
  --max N             results per search (default 8)
  --search-mode <fast|normal|slow>
  --ai-model <slug>   override the LLM (default deepseek/deepseek-v4-pro)
  --budget-ms N         Override the self-budget (0 = unlimited). Also SURF_AI_BUDGET_MS.
  --no-cache            Skip the response cache for this run.

Output:
  --json              structured envelope (plan, ledger, sources, diagnostics)
  --ledger            append the per-query coverage table
  --out <file>        also write the answer to a file
  --quiet             silence the stderr progress log
  --help, -h · --version, -v

⚠ No time budget is enforced. On a harness with a bash timeout, either raise it
  (surf-research-skill project-config), give the Bash call an explicit long
  timeout, or use surf-search-normal instead.

Setup (once):  surf-research-skill ai-setup     # stores the OpenRouter key
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

if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
  process.stdout.write(HELP);
  process.exit(argv.length === 0 ? 2 : 0);
}
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}

await migrateLegacy();

const { pos, flags } = parseFlags(argv);
if (flags.quiet) setSilent(true);

try {
  const code = await runAiCommand({ pos, flags, mode: 'unlimit' });
  process.exit(code);
} catch (e) {
  process.exit(reportAiError(e));
}
