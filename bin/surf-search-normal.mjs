#!/usr/bin/env node
// surf-search-normal — one autonomous research round, guaranteed to fit inside
// the calling agent's bash timeout.
//
// The CLI does everything: an LLM (DeepSeek via OpenRouter) turns your brief
// into a category-diverse query set, every query runs concurrently through the
// Tavily → Parallel → Brave → keyless fallback chain, and the LLM writes the
// final cited answer in the shape you asked for. Rate limits, dead keys,
// unavailable models and failed searches are all absorbed in here — you get an
// answer, not an error to handle.
//
// Need more than one round? Use `surf-search-unlimit`.

import { parseFlags } from '../src/lib/flags.mjs';
import { setSilent } from '../src/lib/progress.mjs';
import { runAiCommand, reportAiError } from '../src/lib/ai/cli.mjs';
import { migrateLegacy } from '../src/lib/state.mjs';

const VERSION = '7.0.0';

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
  --max-queries N     queries this round (default 6, max 24)
  --concurrency N     parallel searches (default 6, max 16)
  --max N             results per search (default 5)
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

One round, by design: the whole run is fitted inside the harness's detected
bash timeout, so it returns an answer instead of being killed mid-flight.
For iterative deepening (analyze the harvest, search again, repeat) use:
  surf-search-unlimit "<question>"

Setup (once):  surf-research-skill ai-setup     # stores the OpenRouter key
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

const { pos, flags } = parseFlags(argv);
if (flags.quiet) setSilent(true);

try {
  const code = await runAiCommand({ pos, flags, mode: 'normal' });
  process.exit(code);
} catch (e) {
  process.exit(reportAiError(e));
}
