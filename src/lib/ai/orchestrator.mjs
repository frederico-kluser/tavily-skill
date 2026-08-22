// surf-ai orchestrator — the whole research loop, in code.
//
// The calling agent hands over a brief (what it is doing, what it needs, what
// it already believes) and gets back a finished, cited answer. Everything in
// between happens here:
//
//   1. PLAN      DeepSeek turns the brief into a set of sub-questions and a
//                category-diverse query array.
//   2. SEARCH    Every query runs CONCURRENTLY through the existing dispatch
//                layer — which already rotates keys and falls back across
//                Tavily → Parallel → Brave, and, as a last resort here, down
//                to the keyless Wikipedia/DuckDuckGo tier.
//   3. ANALYZE   DeepSeek reads the harvest and says what is still open.
//   4. LOOP      In `unlimit` mode, open points become the next round's
//                queries. Repeat until resolved, out of rounds, or out of new
//                questions to ask.
//   5. SYNTHESIZE DeepSeek writes the answer in the exact shape the agent
//                asked for, citing the numbered source index.
//
// The two modes are the only knob the agent has:
//   normal   — exactly one round, and the whole run is fitted inside the
//              harness's bash timeout so it can never be killed mid-flight.
//   unlimit  — as many rounds as the question needs, no self-imposed deadline.
//
// Nothing in here is allowed to hand the agent a failure it must handle:
// every LLM stage degrades to a deterministic fallback, and every search
// failure is recorded as a ledger row rather than aborting the run.

import { loadState, saveStateAtomic } from '../state.mjs';
import { dispatch, DispatchError, detectHarnessBudgetMs, detectHarnessName } from '../dispatch.mjs';
import { mapPool } from '../pool.mjs';
import { progress } from '../progress.mjs';
import { clamp } from '../flags.mjs';
import { Ledger } from './ledger.mjs';
import { chat, AiUnavailableError, resolveModels, mergeEnvKeys, snapshotForPersist } from './openrouter.mjs';
import {
  PLAN_SCHEMA, ANALYSIS_SCHEMA,
  planSystem, planUser, analysisSystem, analysisUser,
  synthesisSystem, synthesisUser,
} from './prompts.mjs';
import { heuristicPlan, heuristicAnalysis, heuristicSynthesis } from './heuristics.mjs';

const VERSION = '7.0.0';

export const MODES = ['normal', 'unlimit'];

// Share of the total time budget each phase may consume (normal mode only).
// The remaining 5% is cushion so we return an answer instead of being SIGTERMed.
const PLAN_SHARE = 0.20;
const SEARCH_SHARE = 0.45;
const SYNTH_SHARE = 0.30;
// Once planning is done, whatever time is left is split between searching and
// synthesizing in the SEARCH:SYNTH ratio above (0.6 / 0.4).
const SEARCH_OF_REMAINING = SEARCH_SHARE / (SEARCH_SHARE + SYNTH_SHARE);

const DEFAULTS = {
  normal:  { maxRounds: 1, maxQueries: 6,  concurrency: 6, max: 5 },
  unlimit: { maxRounds: 6, maxQueries: 10, concurrency: 8, max: 8 },
};

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// When no harness declares a bash timeout, dispatch() assumes 30 s — a sane
// floor for a single 1-3 s search call. It is the wrong floor for surf-ai: a
// plan + fan-out + synthesis cannot happen in 30 s, and every mainstream
// harness allows far more (Claude Code defaults to 120 s and, since v2.1.210,
// backgrounds rather than kills on timeout; Pi core enforces none at all).
// So in normal mode we replace the *guess* with a realistic default and say so.
// A measured budget — BASH_DEFAULT_TIMEOUT_MS, PI_*, an explicit --budget-ms —
// is always honored as-is.
const UNKNOWN_HARNESS_AI_BUDGET_MS = 110_000;

function resolveNormalBudget(opts, searchFlags, harness) {
  const explicit = Number(opts.budgetMs ?? process.env.SURF_AI_BUDGET_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (explicit === 0) return Infinity;

  const detected = detectHarnessBudgetMs(searchFlags);
  if (harness.startsWith('unknown')) {
    progress.info(
      `surf-ai: no harness bash timeout detected — budgeting ${UNKNOWN_HARNESS_AI_BUDGET_MS / 1000}s. ` +
      `If your harness kills commands sooner (GH Copilot CLI defaults to 30s), run ` +
      `'surf-research-skill project-config' or pass --budget-ms <ms>.`
    );
    return UNKNOWN_HARNESS_AI_BUDGET_MS;
  }
  return detected;
}

/**
 * @param {object} ctx   { question, task, goal, insights, deliverable }
 * @param {object} opts  { mode, concurrency, maxRounds, maxQueries, max,
 *                         aiModel, flags, searchMode }
 */
export async function runSurfAi(ctx, opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : 'normal';
  const d = DEFAULTS[mode];
  const startTs = Date.now();

  const concurrency = clamp(Math.floor(Number(opts.concurrency) || d.concurrency), 1, 16);
  const maxQueries = clamp(Math.floor(Number(opts.maxQueries) || d.maxQueries), 1, 24);
  const maxRounds = mode === 'normal'
    ? 1
    : clamp(Math.floor(Number(opts.maxRounds) || d.maxRounds), 1, 50);
  const perSearchMax = clamp(Math.floor(Number(opts.max) || d.max), 1, 20);

  // Search flags handed to dispatch. `unlimit` opts out of the self-budget
  // abort; `normal` keeps it so a long provider call can't eat the whole run.
  const searchFlags = {
    ...(opts.flags || {}),
    'no-budget': mode === 'unlimit' ? true : !!(opts.flags && opts.flags['no-budget']),
    'confirm-expensive': true, // surf-ai only ever issues plain searches
  };
  delete searchFlags.provider; // never pin: fallback is the point

  // Report the harness we actually detected, NOT the one implied by the
  // no-budget flag unlimit mode injects — otherwise every unlimit run would
  // claim "no-limit (--no-budget)" on a harness that plainly has a timeout.
  const harness = detectHarnessName(opts.flags || {});
  const budgetMs = mode === 'unlimit'
    ? Infinity
    : resolveNormalBudget(opts, searchFlags, harness);
  const unlimitedTime = !Number.isFinite(budgetMs);
  const deadline = unlimitedTime ? Infinity : startTs + budgetMs * 0.95;
  const remaining = () => (unlimitedTime ? Infinity : Math.max(0, deadline - Date.now()));

  const state = await loadState();
  state._inMemory = true; // concurrent dispatches share it; we persist ourselves
  const envKeys = mergeEnvKeys(state);
  if (envKeys) {
    progress.info(`surf-ai: using ${envKeys} OpenRouter key(s) from the environment (not persisted)`);
  }
  const persist = () => {
    // Best-effort: a failed key-state write must never sink the research run.
    // snapshotForPersist strips env-sourced keys so they never reach disk.
    try {
      saveStateAtomic(snapshotForPersist(state)).catch(() => {});
    } catch {}
  };

  const runCtx = {
    ...ctx,
    today: nowIsoDate(),
  };

  const ledger = new Ledger();
  const diagnostics = {
    mode, harness, concurrency, maxRounds, maxQueries,
    models: resolveModels(opts.aiModel),
    llm_calls: [],
    degraded: [],
    budget_ms: unlimitedTime ? null : budgetMs,
  };

  const llm = async (label, o) => {
    const r = await chat({
      ...o,
      state,
      model: opts.aiModel,
      label,
      onStateChange: persist,
    });
    diagnostics.llm_calls.push({
      stage: label, model: r.model, key_index: r.key_index,
      latency_ms: r.latency_ms,
      tokens: (r.usage && r.usage.total_tokens) || null,
      cost: (r.usage && r.usage.cost) != null ? r.usage.cost : null,
    });
    return r;
  };

  // ---------------------------------------------------------------- PLAN ---
  progress.start(
    `surf-ai [${mode}] planning · harness=${harness}` +
    (unlimitedTime ? ' · no time budget (unlimit)' : ` · budget ${Math.round(budgetMs / 1000)}s`)
  );

  let plan;
  const planTimeout = unlimitedTime
    ? 180_000
    : Math.max(8_000, Math.min(remaining() * PLAN_SHARE, 90_000));
  try {
    const r = await llm('plan', {
      system: planSystem(),
      user: planUser(runCtx, { maxQueries }),
      schema: PLAN_SCHEMA,
      schemaName: 'surf_ai_plan',
      timeoutMs: planTimeout,
      temperature: 0.3,
    });
    plan = normalizePlan(r.value, maxQueries);
    if (!plan.queries.length) throw new Error('planner returned no queries');
  } catch (e) {
    const why = e instanceof AiUnavailableError ? e.message : (e.message || String(e));
    progress.warn(`surf-ai planner unavailable (${why}) — using the deterministic plan`);
    diagnostics.degraded.push({ stage: 'plan', reason: why });
    plan = heuristicPlan(runCtx, { maxQueries });
  }

  progress.info(`surf-ai plan: ${plan.sub_questions.length} sub-question(s), ${plan.queries.length} quer${plan.queries.length === 1 ? 'y' : 'ies'}`);

  // --------------------------------------------------------------- ROUNDS ---
  let round = 0;
  let analysis = null;
  let pending = plan.queries;
  let stopReason = 'completed the planned round';

  while (round < maxRounds && pending.length) {
    round++;

    // Drop anything already searched — repeated queries are the classic way an
    // iterative loop burns credits without learning anything.
    const fresh = [];
    for (const q of pending) {
      if (!q || !q.q || ledger.hasQuery(q.q)) continue;
      fresh.push(q);
      if (fresh.length >= maxQueries) break;
    }
    if (!fresh.length) {
      stopReason = 'the next round produced only queries that had already been run';
      break;
    }

    const searchBudget = unlimitedTime
      ? Infinity
      : Math.max(5_000, remaining() * SEARCH_OF_REMAINING);
    progress.start(`surf-ai round ${round}/${maxRounds}: ${fresh.length} searches · concurrency ${concurrency}`);

    const roundStart = Date.now();
    const settled = await mapPool(fresh, concurrency, async (item) => {
      // Out of time mid-round: fail the remaining items fast and cleanly so
      // the synthesis still happens with whatever we already have.
      if (!unlimitedTime && Date.now() - roundStart > searchBudget) {
        throw Object.assign(new Error('skipped: round time budget exhausted'), { code: 'RoundBudgetExhausted' });
      }
      return runOneSearch(item, { state, searchFlags, perSearchMax, searchMode: opts.searchMode });
    });

    settled.forEach((r, i) => {
      if (r && r.ok) ledger.addSuccess(round, fresh[i], r.value);
      else ledger.addFailure(round, fresh[i], (r && r.error) || new Error('unknown error'));
    });

    const s = ledger.stats();
    progress.done(`surf-ai round ${round}: ${s.succeeded}/${s.queries} ok, ${s.failed} failed · ${s.sources} unique source(s)`);

    pending = [];

    // Normal mode is one round by contract — no analysis call, no second wave.
    if (mode === 'normal') { stopReason = 'normal mode: single round by design'; break; }
    if (round >= maxRounds) { stopReason = `hit the round cap (${maxRounds})`; break; }
    if (!unlimitedTime && remaining() < 20_000) { stopReason = 'ran out of time budget'; break; }

    // ------------------------------------------------------------ ANALYZE ---
    try {
      const r = await llm('analyze', {
        system: analysisSystem(),
        user: analysisUser(runCtx, {
          plan,
          digest: ledger.digest({ perResult: 800, maxResults: 5, maxChars: 90_000 }),
          alreadyRan: [...ledger.seenQueries],
          round,
          maxRounds,
          maxNextQueries: maxQueries,
        }),
        schema: ANALYSIS_SCHEMA,
        schemaName: 'surf_ai_analysis',
        timeoutMs: unlimitedTime ? 180_000 : Math.max(10_000, remaining() * 0.3),
        temperature: 0.2,
      });
      analysis = r.value || null;
    } catch (e) {
      const why = e instanceof AiUnavailableError ? e.message : (e.message || String(e));
      progress.warn(`surf-ai analyst unavailable (${why}) — stopping after round ${round}`);
      diagnostics.degraded.push({ stage: 'analyze', reason: why });
      analysis = heuristicAnalysis(ledger);
      stopReason = 'the analysis model was unavailable; stopped after this round';
      break;
    }

    if (analysis && analysis.resolved) {
      stopReason = analysis.stop_reason || 'the analyst judged the question resolved';
      progress.info(`surf-ai: resolved after round ${round} (confidence: ${analysis.confidence || 'n/a'})`);
      break;
    }

    const next = Array.isArray(analysis && analysis.next_queries) ? analysis.next_queries : [];
    if (!next.length) {
      stopReason = (analysis && analysis.stop_reason) || 'the analyst had no further queries to run';
      break;
    }
    progress.info(`surf-ai: ${(analysis.open_points || []).length} open point(s) → ${next.length} follow-up quer${next.length === 1 ? 'y' : 'ies'}`);
    pending = next.map((q, i) => ({
      id: q.id || `r${round + 1}q${i + 1}`,
      q: q.q,
      sub: q.sub || 'follow-up',
      category: q.category || null,
    }));
  }

  // ---------------------------------------------------------- SYNTHESIZE ---
  const stats = ledger.stats();
  let answer;
  let synthesized = false;

  if (stats.sources === 0) {
    // Nothing came back from any provider, keyed or keyless. Spending LLM
    // tokens to summarize nothing helps no one — hand back the diagnosis.
    progress.warn('surf-ai: no sources retrieved — emitting the failure report instead of a synthesis');
    diagnostics.degraded.push({ stage: 'synthesize', reason: 'no sources retrieved' });
    answer = noEvidenceReport(runCtx, ledger);
  } else {
    try {
      const r = await llm('synthesize', {
        system: synthesisSystem(runCtx),
        user: synthesisUser(runCtx, {
          plan,
          digest: ledger.digest({ perResult: 1400, maxResults: 6, maxChars: 130_000 }),
          sources: ledger.sourcesText(),
          analysis,
          rounds: round,
        }),
        timeoutMs: unlimitedTime ? 300_000 : Math.max(12_000, remaining() * 0.9),
        temperature: 0.3,
        maxTokens: Number(process.env.SURF_AI_MAX_TOKENS) || 8000,
      });
      answer = String(r.value || r.text || '').trim();
      synthesized = !!answer;
    } catch (e) {
      const why = e instanceof AiUnavailableError ? e.message : (e.message || String(e));
      progress.warn(`surf-ai synthesizer unavailable (${why}) — emitting the evidence brief`);
      diagnostics.degraded.push({ stage: 'synthesize', reason: why });
      answer = heuristicSynthesis(runCtx, ledger, { reason: why });
    }
    if (!synthesized && !answer) {
      answer = heuristicSynthesis(runCtx, ledger, { reason: 'the model returned an empty answer' });
    }
  }

  // Persist key state (burns, cooldowns, last-good indexes) once, at the end.
  try {
    await saveStateAtomic(snapshotForPersist(state));
  } catch {}

  const elapsed = Date.now() - startTs;
  progress.done(
    `surf-ai done: ${round} round(s), ${stats.queries} quer${stats.queries === 1 ? 'y' : 'ies'}, ` +
    `${stats.sources} source(s), ${elapsed}ms${diagnostics.degraded.length ? ` · ${diagnostics.degraded.length} degraded stage(s)` : ''}`
  );

  return {
    mode,
    answer,
    synthesized,
    rounds: round,
    stop_reason: stopReason,
    plan,
    analysis,
    ledger,
    stats,
    diagnostics,
    elapsed_ms: elapsed,
  };
}

/**
 * One search, with the last-resort keyless fallback.
 *
 * dispatch() already handles key rotation and Tavily → Parallel → Brave
 * fallback. What it does NOT do on its own is drop to the free Wikipedia/DDG
 * tier, because surf-research-agent-skill is a keyed product. surf-ai does drop
 * there: a degraded answer beats no answer, and the agent is told which
 * provider answered.
 */
async function runOneSearch(item, { state, searchFlags, perSearchMax, searchMode }) {
  const args = {
    query: item.q,
    mode: searchMode || 'normal',
    max: perSearchMax,
  };
  try {
    return await dispatch('search', args, searchFlags, { state });
  } catch (e) {
    const keylessWorthIt = e instanceof DispatchError &&
      (e.code === 'NoProviderAvailable' || e.code === 'AllProvidersExhausted' || e.code === 'NoUsableKey');
    if (!keylessWorthIt) throw e;
    progress.warn(`surf-ai: "${item.q}" → keyed providers unavailable (${e.code}); falling back to keyless search`);
    return dispatch('search', args, { ...searchFlags, keyless: true, 'no-cache': true }, { state });
  }
}

/** Coerce whatever the planner returned into the shape the loop expects. */
function normalizePlan(raw, maxQueries) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const subs = Array.isArray(p.sub_questions) ? p.sub_questions : [];
  const queries = (Array.isArray(p.queries) ? p.queries : [])
    .filter(q => q && typeof q.q === 'string' && q.q.trim())
    .slice(0, maxQueries)
    .map((q, i) => ({
      id: q.id || `q${i + 1}`,
      q: q.q.trim().slice(0, 380),
      sub: q.sub || (subs[0] && subs[0].id) || 'sq1',
      category: q.category || null,
    }));
  return {
    restated_objective: typeof p.restated_objective === 'string' ? p.restated_objective : '',
    sub_questions: subs
      .filter(s => s && s.question)
      .map((s, i) => ({ id: s.id || `sq${i + 1}`, question: s.question, why: s.why || '' })),
    success_criteria: (Array.isArray(p.success_criteria) ? p.success_criteria : []).filter(x => typeof x === 'string'),
    queries,
  };
}

function noEvidenceReport(ctx, ledger) {
  const lines = [];
  lines.push(`> ❌ **No sources retrieved.** Every search failed, so there is nothing to synthesize.`);
  lines.push('');
  lines.push(`# ${ctx.question}`);
  lines.push('');
  lines.push('## What was attempted');
  for (const row of ledger.rows) {
    lines.push(`- \`${row.query}\` — ${row.ok ? 'returned 0 results' : `${row.error.code}: ${row.error.message}`}`);
  }
  lines.push('');
  lines.push('## Fix');
  lines.push('- `surf-research-skill keys list` — check whether every search key is burned.');
  lines.push('- `surf-research-skill keys add --provider tavily <key>` — add a working search key.');
  lines.push('- `surf-research-skill project-config` — if the failures are timeouts, raise this project\'s bash timeout.');
  lines.push('- Rerun with `surf-search-unlimit` if the harness deadline was the limiting factor.');
  return lines.join('\n');
}
