// surf-ai orchestrator — the whole research loop, in code.
//
// The calling agent hands over a brief (what it is doing, what it needs, what
// it already believes) and gets back a finished, cited answer. Everything in
// between happens here:
//
//   1. PLAN      DeepSeek turns the brief into a set of sub-questions and a
//                category-diverse query array.
//   2. WAVE      Up to `subAgents` queries run CONCURRENTLY through dispatch,
//                which rotates Brave keys and paces every request against the
//                plan's real rate limit. There is no other provider and no
//                keyless tier: a run that cannot reach Brave fails loudly.
//   3. ANALYZE   DeepSeek reads the harvest and says what is still open, which
//                branches are finished, and whether the sources have saturated.
//   4. DEEPEN    Follow-ups enter a priority FRONTIER as tree nodes that know
//                their parent and depth, so the next wave can descend into a
//                thin branch instead of re-searching a fat one. Repeat until
//                the branches close, the sources saturate, or the caps bite.
//   5. SYNTHESIZE DeepSeek writes the answer in the exact shape the agent
//                asked for, citing the numbered source index.
//
// The knobs the agent has:
//   normal   — exactly one wave, fitted inside the harness's bash timeout so it
//              can never be killed mid-flight.
//   unlimit  — as many waves as the question needs, no self-imposed deadline.
//   --sub-agents N — the ONE simultaneity budget (default 10). It is the wave
//              width and the worker-pool width at the same time, so the two can
//              never multiply into a burst the Brave plan cannot serve.
//
// Nothing in here is allowed to hand the agent a failure it must handle:
// every LLM stage degrades to a deterministic fallback, and every search
// failure is recorded as a ledger row rather than aborting the run.

import { loadState, saveStateAtomic } from '../state.mjs';
import { dispatch, detectHarnessBudgetMs, detectHarnessName } from '../dispatch.mjs';
import { effectiveParallelism } from '../ratelimit.mjs';
import { Frontier, makeNode } from './frontier.mjs';
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

// (No VERSION const here on purpose: this module never used one. The single
// source, for anything that does, is src/lib/version.mjs.)

export const MODES = ['normal', 'unlimit'];

// Share of the total time budget each phase may consume (normal mode only).
// The remaining 5% is cushion so we return an answer instead of being SIGTERMed.
const PLAN_SHARE = 0.20;
const SEARCH_SHARE = 0.45;
const SYNTH_SHARE = 0.30;
// Once planning is done, whatever time is left is split between searching and
// synthesizing in the SEARCH:SYNTH ratio above (0.6 / 0.4).
const SEARCH_OF_REMAINING = SEARCH_SHARE / (SEARCH_SHARE + SYNTH_SHARE);

// `subAgents` is deliberately the same number in both modes: it is a
// SIMULTANEITY ceiling, not a depth setting. Depth is maxRounds/maxDepth.
const DEFAULTS = {
  normal:  { maxRounds: 1, maxQueries: 10, subAgents: 10, max: 5, maxDepth: 2 },
  unlimit: { maxRounds: 6, maxQueries: 14, subAgents: 10, max: 8, maxDepth: 3 },
};

// The documented ceiling for --sub-agents. Above this the queueing imposed by
// Brave's rate limiter dominates and more workers only add latency.
export const MAX_SUB_AGENTS = 20;
export const DEFAULT_SUB_AGENTS = 10;

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
 * @param {object} opts  { mode, subAgents, maxRounds, maxQueries, maxDepth,
 *                         max, aiModel, flags, searchMode }
 *                       `concurrency` is accepted as a legacy alias of subAgents.
 */
/**
 * A numeric knob with a default. The distinction that matters: an ABSENT knob
 * is the default; a PRESENT zero is a number the caller chose — it clamps
 * downstream like any other out-of-range value instead of being silently
 * replaced by the default.
 */
function knob(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

export async function runSurfAi(ctx, opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : 'normal';
  const d = DEFAULTS[mode];
  const startTs = Date.now();

  // ONE simultaneity budget. `--sub-agents` is canonical; `--concurrency` is
  // the legacy alias and loses to it. Two independent knobs would multiply:
  // 10 sub-agents each running 8 concurrent searches is 80 requests at once,
  // against a plan that may allow one per second.
  //
  // A knob the caller explicitly set to a NUMBER is honoured — including zero,
  // which then clamps to the minimum like any other out-of-range value.
  // `Number(x) || default` silently turned 0 into the DEFAULT: asking for
  // subAgents:0 / maxDepth:0 / maxQueries:0 gave back 10/2/10, the opposite of
  // what was asked, with no warning.
  const subAgents = clamp(knob(opts.subAgents ?? opts.concurrency, d.subAgents), 1, MAX_SUB_AGENTS);
  // The wave can never be wider than the query budget, so the query budget must
  // not be the thing that silently shrinks a requested fan-out.
  const maxQueries = Math.max(
    clamp(knob(opts.maxQueries, d.maxQueries), 1, 40),
    subAgents,
  );
  const maxRounds = mode === 'normal'
    ? 1
    : clamp(knob(opts.maxRounds, d.maxRounds), 1, 50);
  const maxDepth = clamp(knob(opts.maxDepth, d.maxDepth), 1, 6);
  // Distinguish "the user asked for N results" from "we defaulted to N". Only
  // an explicit --max may override the tier implied by --search-mode; otherwise
  // --search-mode was inert, because a defaulted max always won.
  const userMax = Number.isFinite(Number(opts.max)) && Number(opts.max) > 0
    ? clamp(Math.floor(Number(opts.max)), 1, 20)
    : null;
  const perSearchMax = userMax ?? d.max;

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

  // Tell the caller the truth about its fan-out. Asking for 10 simultaneous
  // sub-agents on a 1 req/s Brave plan does not fail — the rate limiter simply
  // serialises them — but the user deserves to know the wave will take ~10s
  // instead of ~1s, and that a second key would actually widen it.
  const braveKeys = (state.brave && state.brave.keys) || [];
  const effParallel = await effectiveParallelism(braveKeys);
  if (Number.isFinite(effParallel) && effParallel < subAgents) {
    progress.warn(
      `surf-ai: --sub-agents ${subAgents} exceeds what your Brave plan can serve at once ` +
      `(~${effParallel} req/s across ${braveKeys.length} key(s)). The wave still runs — the rate ` +
      `limiter paces it — but expect ~${Math.ceil(subAgents / effParallel)}s per wave. ` +
      `Add another Brave key to widen it, or lower --sub-agents.`,
    );
  }

  const frontier = new Frontier({ maxDepth });
  const ledger = new Ledger();
  const diagnostics = {
    mode, harness, subAgents, maxRounds, maxQueries, maxDepth,
    effective_parallelism: Number.isFinite(effParallel) ? effParallel : null,
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

  progress.info(
    `surf-ai plan: ${plan.sub_questions.length} sub-question(s), ${plan.queries.length} seed quer${plan.queries.length === 1 ? 'y' : 'ies'} ` +
    `· up to ${subAgents} sub-agent(s) per wave, depth ≤ ${maxDepth}`
  );

  // ---------------------------------------------------------------- WAVES ---
  // Every node the run has ADMITTED, by id — the lineage map. It has to
  // outlive the wave that created it: the analyst routinely names a parent from
  // an earlier wave, and resolving parents against the CURRENT wave only made
  // every such follow-up restart at depth 1. That silently defeated --max-depth
  // — the flag the caller uses to cap how deep (and how expensive) a run gets.
  const nodesById = new Map();
  const remember = (res) => {
    if (res && res.admitted && res.node) nodesById.set(res.node.id, res.node);
    return res;
  };

  // Seed the frontier from the plan. Every seed is a depth-0 breadth node.
  for (const q of plan.queries) {
    remember(frontier.admit(makeNode({
      id: q.id, q: q.q, sub: q.sub, category: q.category,
      depth: 0, priority: q.priority ?? 0.6, kind: 'breadth',
    })));
  }

  let round = 0;
  let analysis = null;
  // Left unset on purpose. It used to start at 'completed the planned wave',
  // which was simply false whenever the loop never ran: a plan rejected in full
  // at the admission gate reported rounds: 0 and a completed wave in the same
  // breath, and the agent reading that concluded the research was done.
  let stopReason = null;
  // TWO stop conditions, because they are two different events. They shared one
  // counter, so "this wave found a new source" cleared the "this wave admitted
  // nothing" tally and vice versa — neither dry spell could ever reach 2, and
  // the only thing that ever stopped a stubborn run was the 50-wave cap.
  let wavesWithoutNewSources = 0;
  let wavesWithoutAdmission = 0;

  while (round < maxRounds && frontier.size) {
    round++;

    const wave = frontier.popWave(subAgents, { wave: round });
    if (!wave.length) {
      stopReason = 'the frontier had no admissible queries left';
      break;
    }

    const searchBudget = unlimitedTime
      ? Infinity
      : Math.max(5_000, remaining() * SEARCH_OF_REMAINING);
    const depths = wave.map(n => n.depth);
    progress.start(
      `surf-ai wave ${round}/${maxRounds}: ${wave.length} sub-agent(s) ` +
      `· depth ${Math.min(...depths)}-${Math.max(...depths)} · ${frontier.openBranches} open branch(es)`
    );

    const roundStart = Date.now();
    const settled = await mapPool(wave, subAgents, async (node) => {
      // Out of time mid-wave: fail the remaining items fast and cleanly so the
      // synthesis still happens with whatever we already have.
      if (!unlimitedTime && Date.now() - roundStart > searchBudget) {
        throw Object.assign(new Error('skipped: wave time budget exhausted'), { code: 'WaveBudgetExhausted' });
      }
      return runOneSearch(node, { state, searchFlags, perSearchMax, searchMode: opts.searchMode, userMax });
    });

    const sourcesBefore = ledger.stats().sources;
    const branchHits = new Map();
    settled.forEach((r, i) => {
      const node = wave[i];
      if (r && r.ok) {
        const before = ledger.stats().sources;
        ledger.addSuccess(round, node, r.value);
        const gained = ledger.stats().sources - before;
        branchHits.set(node.sub, (branchHits.get(node.sub) || 0) + gained);
        node.status = 'done';
      } else {
        ledger.addFailure(round, node, (r && r.error) || new Error('unknown error'));
        node.status = 'failed';
        // A FAILED search must not bar its own query for the rest of the run:
        // popWave already removed the node, and without this the analyst
        // re-proposing the identical query was refused as "duplicate of a query
        // already admitted" — even though the query never produced a single
        // result. Only a search that SUCCEEDED bars its key (admittedKeys).
        frontier.forget(node.q);
      }
    });

    const newSources = ledger.stats().sources - sourcesBefore;
    const s = ledger.stats();
    progress.done(
      `surf-ai wave ${round}: ${s.succeeded}/${s.queries} ok, ${s.failed} failed ` +
      `· +${newSources} new source(s) (${s.sources} total)`
    );

    // A branch that produced nothing new twice in a row is done, whatever the
    // analyst thinks. This is a counter, not an opinion, and it is what stops a
    // branch from absorbing waves while adding no evidence.
    for (const sub of new Set(wave.map(n => n.sub))) {
      if ((branchHits.get(sub) || 0) > 0) frontier.noteHit(sub);
      else if (frontier.noteMiss(sub)) {
        progress.info(`surf-ai: closed branch '${sub}' — two waves with no new sources`);
      }
    }

    if (mode === 'normal') { stopReason = 'normal mode: a single wave by design'; break; }
    if (round >= maxRounds) { stopReason = `hit the wave cap (${maxRounds})`; break; }
    if (!unlimitedTime && remaining() < 20_000) { stopReason = 'ran out of time budget'; break; }
    if (newSources === 0) {
      wavesWithoutNewSources++;
      if (wavesWithoutNewSources >= 2) {
        stopReason = 'two consecutive waves returned no new sources (saturated)';
        break;
      }
    } else {
      wavesWithoutNewSources = 0;
    }

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
          // The analyst also hears about close requests that were IGNORED.
          // Closing a sub-question that never existed is recorded as a phantom
          // close (see Frontier.closeBranch) and published in the frontier
          // snapshot, but an analyst that never hears about it keeps proposing
          // the hallucinated id every wave. Riding the rejected list keeps the
          // audit trail in the same shape the analyst already reads.
          rejected: [
            ...frontier.rejected,
            ...[...frontier.phantomClosed].map(sub => ({
              q: `(close requested for branch '${sub}')`,
              reason: 'that sub-question never existed, so the close was ignored',
            })),
          ],
          openBranches: frontier.openBranches,
          closedBranches: [...frontier.closed],
        }),
        schema: ANALYSIS_SCHEMA,
        schemaName: 'surf_ai_analysis',
        timeoutMs: unlimitedTime ? 180_000 : Math.max(10_000, remaining() * 0.3),
        temperature: 0.2,
      });
      analysis = normalizeAnalysis(r.value);
    } catch (e) {
      const why = e instanceof AiUnavailableError ? e.message : (e.message || String(e));
      progress.warn(`surf-ai analyst unavailable (${why}) — stopping after wave ${round}`);
      diagnostics.degraded.push({ stage: 'analyze', reason: why });
      analysis = heuristicAnalysis(ledger);
      stopReason = 'the analysis model was unavailable; stopped after this wave';
      break;
    }

    // A reply that is valid JSON but not an object — `false`, `0`, `""`, an
    // array, a bare string — used to survive the `|| null` guard and then blow
    // up on `analysis.open_points` further down. That crash lands AFTER the
    // wave's Brave requests are paid for: the user buys the searches and
    // receives a stack trace. Stop cleanly and synthesize what the wave found.
    if (!analysis) {
      progress.warn(`surf-ai: the analyst returned a reply that is not an analysis — stopping after wave ${round} and synthesizing what we have`);
      diagnostics.degraded.push({ stage: 'analyze', reason: 'the model returned a reply that is not an analysis object' });
      stopReason = 'the analyst returned an unusable reply; stopped after this wave';
      break;
    }

    // normalizeAnalysis guarantees a string array here. It used to be whatever
    // the model said: `5` made this a TypeError, and `"sq1"` was iterated
    // character by character, permanently closing the branches 's', 'q' and '1'.
    for (const sub of analysis.branches_to_close) {
      const dropped = frontier.closeBranch(sub, 'the analyst reported it answered');
      if (dropped) progress.info(`surf-ai: closed branch '${sub}' (${dropped} pending quer${dropped === 1 ? 'y' : 'ies'} dropped)`);
    }

    if (analysis.resolved) {
      stopReason = analysis.stop_reason || 'the analyst judged the question resolved';
      progress.info(`surf-ai: resolved after wave ${round} (confidence: ${analysis.confidence || 'n/a'})`);
      break;
    }
    if (analysis.saturation) {
      stopReason = analysis.stop_reason || 'the analyst reported source saturation';
      break;
    }

    // --------------------------------------------------------------- ADMIT ---
    const candidates = analysis.next_queries;
    const waveDepth = wave.length ? Math.max(...wave.map(n => n.depth)) : 0;
    let admitted = 0;
    for (const c of candidates) {
      // Lineage is resolved against every node the run ever admitted, not just
      // this wave's — a parent named two waves ago is still a real parent.
      const parent = c.parent ? nodesById.get(c.parent) || null : null;
      // Depth, in three cases:
      //   · breadth              — a new line of enquiry, starts at 0;
      //   · a parent we know     — exactly one level below it;
      //   · a parent we do NOT   — the analyst named an id we never admitted,
      //     so trust nothing: it is at least one level below the wave that
      //     provoked it. A hallucinated ancestor must not buy extra depth.
      const depth = c.kind === 'breadth'
        ? 0
        : (parent ? parent.depth + 1 : (c.parent ? waveDepth + 1 : 1));
      const res = remember(frontier.admit(makeNode({
        id: c.id, q: c.q, sub: c.sub || (parent && parent.sub) || null,
        category: c.category, parent: parent ? parent.id : (c.parent || null),
        depth, priority: c.priority ?? 0.5, kind: c.kind || 'depth',
      })));
      if (res.admitted) admitted++;
    }
    progress.info(
      `surf-ai: ${(analysis.open_points || []).length} open point(s) → ` +
      `${admitted}/${candidates.length} follow-up(s) admitted ` +
      `(${frontier.size} queued, ${frontier.rejected.length} rejected so far)`
    );

    if (!admitted) {
      wavesWithoutAdmission++;
      if (wavesWithoutAdmission >= 2) {
        stopReason = 'two consecutive waves admitted no new queries';
        break;
      }
    } else {
      wavesWithoutAdmission = 0;
    }
    if (!frontier.size) {
      // Say WHY the frontier emptied. "The analyst had nothing left" and "the
      // analyst kept proposing queries that had already been run" look
      // identical from the outside and mean very different things about the
      // quality of the run. And when the gate refused them for some other
      // reason — the depth cap, a closed branch — falling back to
      // analysis.stop_reason printed the analyst's reason for CONTINUING
      // ("go deeper") as the run's reason for STOPPING.
      if (!candidates.length) {
        stopReason = analysis.stop_reason
          ? `the analyst proposed no follow-up (${analysis.stop_reason}) and the frontier is empty`
          : 'the analyst proposed no follow-up and the frontier is empty — every branch is closed or exhausted';
      } else {
        // Nothing is queued, so every one of this pass's candidates was
        // rejected: the last `candidates.length` rejections are exactly them.
        const lastRejections = frontier.rejected.slice(-candidates.length);
        const dupes = lastRejections.filter(r => /duplicate/.test(r.reason)).length;
        stopReason = dupes === lastRejections.length && dupes > 0
          ? `every follow-up the analyst proposed had already been run; ${dupes} duplicate(s) rejected`
          : `every follow-up the analyst proposed was refused at the admission gate (${countReasons(lastRejections)}), so the frontier is empty`;
      }
      break;
    }
  }

  // Only now can the stop reason be stated truthfully: if not one wave ran,
  // saying the planned wave completed is a lie the calling agent acts on.
  if (!stopReason) {
    stopReason = round > 0 ? 'completed the planned wave' : noWaveReason(plan, frontier);
  }

  // ---------------------------------------------------------- SYNTHESIZE ---
  const stats = ledger.stats();
  let answer;
  let synthesized = false;

  if (stats.sources === 0) {
    // Every Brave search failed. Spending LLM tokens to summarize nothing helps
    // no one — hand back the diagnosis instead of a confident empty answer.
    progress.warn('surf-ai: no sources retrieved — emitting the failure report instead of a synthesis');
    diagnostics.degraded.push({ stage: 'synthesize', reason: 'no sources retrieved' });
    answer = noEvidenceReport(runCtx, ledger, { plan, frontier, stopReason });
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
    `surf-ai done: ${round} wave(s), ${stats.queries} quer${stats.queries === 1 ? 'y' : 'ies'}, ` +
    `${stats.sources} source(s), ${elapsed}ms${diagnostics.degraded.length ? ` · ${diagnostics.degraded.length} degraded stage(s)` : ''}`
  );

  return {
    mode,
    answer,
    synthesized,
    rounds: round,
    waves: round,
    frontier: frontier.toJSON(),
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
 * One search.
 *
 * There is no fallback tier below this. Previously, when every keyed provider
 * was unusable, the run quietly dropped to Wikipedia/DuckDuckGo and returned a
 * confident answer at exit 0 — the user could not tell a researched answer from
 * an encyclopedia summary. dispatch now raises, the wave records the failure,
 * and if nothing at all comes back the run says so.
 *
 * `max` is sent ONLY when the user actually asked for a result count. When they
 * did not, the count is left to the provider so that --search-mode determines
 * it. A defaulted `max` used to always be present and always win, which made
 * --search-mode fast/normal/slow produce byte-identical requests.
 */
async function runOneSearch(node, { state, searchFlags, perSearchMax, searchMode, userMax }) {
  // kebab-case CLI flag -> the argument name the Brave adapter reads. The
  // adapter's own allowlist lives in providers/brave.mjs; this is the same
  // mapping bin/surf-research-skill.mjs buildSearchArgs() uses for the `search`
  // verb — the surf-ai path only forwarded query/mode/max, so --domains,
  // --exclude, --time, --country, --safesearch, --goggles and --result-filter
  // were accepted, silently dropped, and the user paid for the web at large
  // while --help promised "all of these now actually reach Brave".
  // (mode/max are deliberately absent: they are the searchMode/userMax knobs
  // handled below, and double-wiring them would fight the tier logic.)
  const SEARCH_ARG_FLAGS = {
    domains: 'domains',
    exclude: 'excludeDomains',
    time: 'time',
    freshness: 'freshness',
    country: 'country',
    safesearch: 'safesearch',
    goggles: 'goggles',
    'result-filter': 'resultFilter',
    offset: 'offset',
    topic: 'topic',
    'start-date': 'startDate',
    'end-date': 'endDate',
    'search-lang': 'searchLang',
    'ui-lang': 'uiLang',
  };
  const args = {
    query: node.q,
    mode: searchMode || undefined,
    ...(userMax != null ? { max: userMax } : (searchMode ? {} : { max: perSearchMax })),
  };
  // Search flags the caller actually passed reach the adapter. An empty string
  // ("--domains=" with nothing after the =) is not a value.
  for (const [flag, arg] of Object.entries(SEARCH_ARG_FLAGS)) {
    const v = searchFlags[flag];
    if (v !== undefined && v !== null && v !== '') args[arg] = v;
  }
  return dispatch('search', args, searchFlags, { state });
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
      priority: Number.isFinite(Number(q.priority)) ? Math.min(1, Math.max(0, Number(q.priority))) : 0.6,
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

/**
 * Coerce whatever the analyst returned into the shape the loop expects.
 *
 * Returns null when the reply cannot be an analysis at all. Everything
 * downstream may then assume: `open_points` and `branches_to_close` are arrays
 * of strings and `next_queries` is an array of objects. Those guarantees are
 * load-bearing, because this stage runs AFTER the wave's Brave requests are
 * already paid for — a malformed field has to degrade the run, never crash it.
 */
function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    ...raw,
    resolved: !!raw.resolved,
    saturation: !!raw.saturation,
    confidence: typeof raw.confidence === 'string' ? raw.confidence : '',
    coverage: Array.isArray(raw.coverage) ? raw.coverage : [],
    open_points: asStringList(raw.open_points),
    // `"sq1"` means the branch sq1 — not the three branches 's', 'q' and '1',
    // which is what iterating a string produced. A number names no branch at
    // all, so it closes none instead of throwing `is not iterable`.
    branches_to_close: asStringList(raw.branches_to_close),
    next_queries: Array.isArray(raw.next_queries)
      ? raw.next_queries.filter(c => c && typeof c === 'object' && !Array.isArray(c))
      : [],
    stop_reason: typeof raw.stop_reason === 'string' ? raw.stop_reason : '',
  };
}

/** A list of non-empty strings — from a list, from a lone string, or nothing. */
function asStringList(v) {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

/** "2× duplicate…; 1× deeper than the depth cap (1)" — rejections, tallied. */
function countReasons(rejections) {
  const byReason = new Map();
  for (const r of rejections) byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
  return [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n}× ${reason}`)
    .join('; ');
}

/** Why a run finished without ever entering the wave loop. */
function noWaveReason(plan, frontier) {
  const planned = plan.queries.length;
  if (!planned) return 'no wave ran: the planner produced no query at all';
  if (!frontier.rejected.length) return 'no wave ran: the frontier was empty before the first wave';
  return `no wave ran: all ${planned} planned quer${planned === 1 ? 'y was' : 'ies were'} ` +
         `refused at the admission gate (${countReasons(frontier.rejected)})`;
}

/**
 * The zero-source report.
 *
 * Two very different situations end here and the agent reading the output has
 * to tell them apart:
 *   · searches ran and failed — quota WAS spent; list every attempt;
 *   · nothing was ever issued — the plan died at the admission gate. Printing
 *     "What was attempted" from an empty ledger told the agent that every
 *     search had failed when not one request left the process.
 */
function noEvidenceReport(ctx, ledger, { plan, frontier, stopReason } = {}) {
  const rows = ledger.rows;
  const failed = ledger.failedRows.length;
  const lines = [];

  if (!rows.length) {
    lines.push('> ❌ **No sources retrieved — and no search was ever issued.** Not one request reached Brave, so no quota was spent.');
    lines.push('');
    lines.push(`# ${ctx.question}`);
    lines.push('');
    lines.push('## Why nothing ran');
    lines.push(`- ${stopReason || 'the frontier was empty before the first wave'}`);
    const rejected = (frontier && frontier.rejected) || [];
    if (rejected.length) {
      lines.push('');
      lines.push(`## The ${rejected.length} quer${rejected.length === 1 ? 'y' : 'ies'} refused at the admission gate`);
      for (const r of rejected.slice(0, 20)) {
        lines.push(`- \`${r.q}\` — ${r.reason}`);
      }
      if (rejected.length > 20) lines.push(`- …and ${rejected.length - 20} more`);
    }
    lines.push('');
    lines.push('## Fix');
    lines.push('- Rephrase the question with concrete nouns. A plan built out of stopwords yields queries with no content words, and those are refused before any request is made.');
    lines.push('- `--max-queries N` — ask the planner for more angles, so one refusal does not empty the plan.');
    lines.push('- Re-run: the plan comes from an LLM and is not deterministic.');
    lines.push('');
    lines.push('_No Brave request was made, so no key, quota, rate limit or timeout is implicated — the run stopped before the network._');
    return lines.join('\n');
  }

  lines.push(failed === rows.length
    ? `> ❌ **No sources retrieved.** Every search failed (${failed} of ${failed}), so there is nothing to synthesize.`
    : `> ❌ **No sources retrieved.** ${rows.length} search(es) ran — ${failed} failed and the rest came back empty — so there is nothing to synthesize.`);
  lines.push('');
  lines.push(`# ${ctx.question}`);
  lines.push('');
  lines.push(`## What was attempted (${rows.length} quer${rows.length === 1 ? 'y' : 'ies'})`);
  for (const row of rows) {
    lines.push(`- \`${row.query}\` — ${row.ok ? 'returned 0 results' : `${row.error.code}: ${row.error.message}`}`);
  }
  lines.push('');
  lines.push('## Fix');
  lines.push('- `surf-research-skill keys list` — check whether the Brave key is burned or cooling.');
  lines.push('- `surf-research-skill keys reset --provider brave` — clear a burn (they also clear monthly).');
  lines.push('- `surf-research-skill keys add --provider brave <key>` — a second key widens the per-second rate budget.');
  lines.push('- `surf-research-skill project-config` — if the failures are timeouts, raise this project\'s bash timeout.');
  lines.push('- Rerun with `surf-search-unlimit` if the harness deadline was the limiting factor.');
  lines.push('');
  lines.push('_A missing or invalid Brave key exits 78 before any search runs, so if you got here the key worked and the searches themselves failed._');
  return lines.join('\n');
}
