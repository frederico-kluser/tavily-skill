// Shared surf-ai command implementation.
//
// Three entry points reach the same code path, so they can never drift:
//   surf-search-normal  <question>              (bin)
//   surf-search-unlimit <question>              (bin)
//   surf-research-skill ai <question> --mode …  (subcommand)

import { readFile, writeFile } from 'node:fs/promises';
import { stdout, stderr } from 'node:process';
import { runSurfAi, MAX_SUB_AGENTS, DEFAULT_SUB_AGENTS } from './orchestrator.mjs';
import { renderMarkdown, renderJson } from './render.mjs';
import { progress } from '../progress.mjs';
import { assertEnum, numericFlag, FlagError } from '../flags.mjs';
import { MODES as SEARCH_MODES } from '../providers/brave.mjs';

export class AiCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiCliError';
    this.code = 'AI_CLI_USAGE';
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Build the research brief from positionals, flags and an optional JSON file.
 * Positional args are joined, so an unquoted question still works; --brief-file
 * exists because long multi-line insights are miserable to escape in bash.
 */
export async function buildBrief(pos, flags) {
  let brief = {};
  if (flags['brief-file']) {
    let txt;
    try {
      txt = await readFile(flags['brief-file'], 'utf8');
    } catch (e) {
      throw new AiCliError(`--brief-file: cannot read ${flags['brief-file']}: ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch (e) {
      throw new AiCliError(`--brief-file: ${flags['brief-file']} is not valid JSON: ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AiCliError('--brief-file must contain a JSON object');
    }
    brief = parsed;
  }

  const question = str(Array.isArray(pos) ? pos.join(' ') : pos) || str(brief.question);
  if (!question) {
    throw new AiCliError(
      'a question is required.\n' +
      '  surf-search-normal  "<question>" [--task ...] [--goal ...] [--insights ...] [--deliverable ...]\n' +
      '  surf-search-unlimit "<question>" [--max-rounds 6]\n' +
      '  …or pass --brief-file brief.json containing {"question": "...", "task": "...", ...}'
    );
  }

  return {
    question,
    task: str(flags.task) || str(brief.task),
    goal: str(flags.goal) || str(brief.goal),
    insights: str(flags.insights) || str(brief.insights),
    deliverable: str(flags.deliverable) || str(brief.deliverable),
  };
}

/**
 * Run one surf-ai command end to end: brief → research loop → rendered output.
 * Returns the exit code; it never throws for research failures, only for
 * usage errors (AiCliError).
 */
export async function runAiCommand({ pos, flags, mode }) {
  const resolvedMode = mode || (flags.mode === 'unlimit' ? 'unlimit' : 'normal');
  if (!mode && flags.mode && flags.mode !== 'normal' && flags.mode !== 'unlimit') {
    throw new AiCliError(`--mode must be 'normal' or 'unlimit' (got '${flags.mode}')`);
  }

  // `--mode` means the RUN mode here, but the standalone bins fix the run mode
  // themselves — so on those, `--mode fast|normal|slow` was parsed, ignored, and
  // silently discarded. Treat it as the tier flag it obviously meant, unless the
  // user also passed --search-mode, which always wins.
  let searchMode = flags['search-mode'];
  if (mode && typeof flags.mode === 'string' && SEARCH_MODES.includes(flags.mode)) {
    if (!searchMode) {
      searchMode = flags.mode;
      progress.info(`surf-ai: read --mode ${flags.mode} as --search-mode (this binary fixes the run mode to '${mode}')`);
    }
  } else if (mode && typeof flags.mode === 'string' && flags.mode !== mode) {
    throw new AiCliError(
      `--mode '${flags.mode}' contradicts this command, which always runs in '${mode}' mode. ` +
      `Did you mean --search-mode ${SEARCH_MODES.join('|')}?`,
    );
  }
  assertEnum('--search-mode', searchMode, SEARCH_MODES);

  // One simultaneity budget. --concurrency survives as a deprecated alias.
  const subAgents = numericFlag(flags['sub-agents'], {
    name: '--sub-agents', min: 1, max: MAX_SUB_AGENTS, fallback: undefined,
  });
  const legacy = numericFlag(flags.concurrency, {
    name: '--concurrency', min: 1, max: MAX_SUB_AGENTS, fallback: undefined,
  });
  if (subAgents === undefined && legacy !== undefined) {
    progress.warn(`surf-ai: --concurrency is deprecated; use --sub-agents=${legacy} (same meaning, default ${DEFAULT_SUB_AGENTS}).`);
  }

  const ctx = await buildBrief(pos, flags);

  const result = await runSurfAi(ctx, {
    mode: resolvedMode,
    subAgents: subAgents ?? legacy,
    maxRounds: numericFlag(flags['max-rounds'], { name: '--max-rounds', min: 1, max: 50, fallback: undefined }),
    maxQueries: numericFlag(flags['max-queries'], { name: '--max-queries', min: 1, max: 40, fallback: undefined }),
    maxDepth: numericFlag(flags['max-depth'], { name: '--max-depth', min: 1, max: 6, fallback: undefined }),
    max: numericFlag(flags.max, { name: '--max', min: 1, max: 20, fallback: undefined }),
    aiModel: flags['ai-model'],
    searchMode,
    budgetMs: flags['budget-ms'],
    flags,
  });

  const text = flags.json
    ? JSON.stringify(renderJson(result), null, 2)
    : renderMarkdown(result, { ledger: !!flags.ledger });

  if (typeof flags.out === 'string' && flags.out) {
    try {
      await writeFile(flags.out, text.endsWith('\n') ? text : text + '\n', 'utf8');
      progress.info(`surf-ai: answer written to ${flags.out}`);
    } catch (e) {
      progress.warn(`surf-ai: could not write ${flags.out}: ${e.message}`);
    }
  }

  stdout.write(text.endsWith('\n') ? text : text + '\n');

  // Non-zero ONLY when nothing at all was retrieved. A degraded-but-cited
  // answer is a success: an agent must not retry over it.
  return result.stats.sources === 0 ? 1 : 0;
}

/** Uniform error printer for the two standalone bins. */
export function reportAiError(e) {
  // A configuration problem is not a failed operation. Exit 78 (EX_CONFIG) so
  // an orchestrating agent can tell "fix your setup" from "the search failed"
  // without parsing the message.
  if (e && typeof e.exitCode === 'number' && e.name === 'GateError') {
    stderr.write(`${e.message}\n`);
    return e.exitCode;
  }
  if (e && e.code === 'FLAG_USAGE') {
    stderr.write(`❌ Error: ${e.message}\n`);
    return 2;
  }
  if (e && e.code === 'AI_CLI_USAGE') {
    stderr.write(`❌ Error: ${e.message}\n`);
    return 2;
  }
  if (e && e.code === 'NO_TTY') {
    stderr.write(`❌ Error: ${e.message}\n`);
    return 2;
  }
  stderr.write(`❌ Error${e && e.code ? ` [${e.code}]` : ''}: ${(e && e.message) || String(e)}\n`);
  return 1;
}
