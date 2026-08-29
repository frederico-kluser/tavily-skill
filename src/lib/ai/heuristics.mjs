// LLM-free fallbacks for surf-ai.
//
// surf-ai's contract with the calling agent is "you always get something
// usable". When the OpenRouter key is missing, out of credit, rate-limited to
// death, or every model is down, these take over. They are deterministic and
// deliberately dumb — but they still run real searches and still hand back a
// cited, structured brief, which beats an error message the agent can't act on.
//
// Every degraded answer says so at the top. The agent must never mistake a
// heuristic brief for a synthesized one.

import { CATEGORIES } from './prompts.mjs';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'are',
  'what', 'which', 'how', 'why', 'when', 'where', 'do', 'does', 'i', 'we',
  'my', 'our', 'it', 'its', 'be', 'with', 'that', 'this', 'from', 'as', 'by',
  'o', 'a', 'os', 'as', 'de', 'da', 'do', 'que', 'para', 'com', 'em', 'um',
  'uma', 'e', 'ou', 'no', 'na', 'se', 'por', 'qual', 'quais', 'como',
]);

/** Keyword-ish core of a sentence, for building search strings. */
export function keywordize(text, max = 12) {
  return String(text || '')
    .replace(/["'`]/g, ' ')
    .replace(/[^\p{L}\p{N}\s.\-_/+#]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, max)
    .join(' ')
    .trim();
}

/**
 * Deterministic query plan. Covers the angles a planner would normally pick:
 * the plain question, official documentation, current state, alternatives,
 * and known problems.
 */
export function heuristicPlan(ctx, { maxQueries = 6 } = {}) {
  const core = keywordize(ctx.question) || String(ctx.question || '').slice(0, 200);
  const goalCore = ctx.goal ? keywordize(ctx.goal, 8) : '';
  const year = (ctx.today || '').slice(0, 4);

  const candidates = [
    { q: String(ctx.question || '').slice(0, 380), category: 'community', sub: 'sq1' },
    { q: `${core} official documentation`, category: 'official-docs', sub: 'sq1' },
    { q: `${core} ${year || ''} latest version changelog`.trim(), category: 'news', sub: 'sq2' },
    { q: `${core} limitations problems issues`, category: 'community', sub: 'sq3' },
    { q: `${core} alternatives comparison`, category: 'benchmark', sub: 'sq3' },
    goalCore ? { q: `${core} ${goalCore}`, category: 'code', sub: 'sq2' } : null,
    { q: `${core} best practices example`, category: 'code', sub: 'sq2' },
  ].filter(Boolean);

  const seen = new Set();
  const queries = [];
  for (const c of candidates) {
    const key = c.q.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queries.push({
      id: `h${queries.length + 1}`,
      q: c.q.slice(0, 380),
      sub: c.sub,
      category: CATEGORIES.includes(c.category) ? c.category : 'community',
      // The frontier orders by priority even when no LLM set one. Earlier
      // candidates are the more literal readings of the question, so they lead.
      priority: Math.max(0.3, 0.9 - queries.length * 0.05),
    });
    if (queries.length >= maxQueries) break;
  }

  return {
    restated_objective: ctx.goal || ctx.question,
    sub_questions: [
      { id: 'sq1', question: String(ctx.question || ''), why: 'the question as asked' },
      { id: 'sq2', question: 'current state, versions and practical usage', why: 'agents need exact, current strings' },
      { id: 'sq3', question: 'limitations, alternatives and known problems', why: 'avoids a confident wrong recommendation' },
    ],
    success_criteria: [
      'the question is answered with at least one cited source',
      'anything still unknown is stated explicitly',
    ],
    queries,
    _degraded: true,
  };
}

/**
 * Deterministic "gap analysis". Without an LLM we cannot judge semantic
 * coverage, so we use the only signal we have: did the searches return
 * anything at all? Never asks for another round — an LLM-less loop would spin
 * without ever getting smarter.
 */
export function heuristicAnalysis(ledger) {
  const stats = ledger.stats();
  const emptySubs = new Set();
  for (const row of ledger.rows) {
    if (!row.ok || !row.results.length) emptySubs.add(row.sub || row.id);
  }
  return {
    resolved: stats.sources > 0,
    confidence: 'low',
    coverage: [...new Set(ledger.rows.map(r => r.sub || r.id))].map(sub => ({
      sub,
      status: emptySubs.has(sub) ? 'thin' : 'answered',
      note: 'heuristic assessment — no LLM was available to judge coverage',
    })),
    open_points: stats.failed
      ? [`${stats.failed} search(es) failed; their angles are uncovered`]
      : [],
    next_queries: [],
    // Without a model we cannot judge which branches are finished, so we close
    // none and let the deterministic saturation counter stop the run instead.
    branches_to_close: [],
    saturation: true,
    stop_reason: 'LLM unavailable — ran the deterministic fallback, one wave only',
    _degraded: true,
  };
}

/**
 * Deterministic brief: grouped, deduplicated, cited. Not a synthesis — it does
 * not draw conclusions, and it says so.
 */
export function heuristicSynthesis(ctx, ledger, { reason } = {}) {
  const lines = [];
  lines.push(`> ⚠ **Degraded mode — no LLM synthesis.** ${reason || 'The OpenRouter model was unavailable.'}`);
  lines.push(`> The searches below ran normally; what is missing is the analysis layer. Read the evidence and draw your own conclusion, or add an OpenRouter key with \`surf-research-skill ai-setup\` and re-run.`);
  lines.push('');
  lines.push(`# Evidence for: ${ctx.question}`);
  if (ctx.goal) lines.push(`\n**Agent objective:** ${ctx.goal}`);
  lines.push('');

  const bySub = new Map();
  for (const row of ledger.rows) {
    const k = row.sub || 'general';
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(row);
  }

  for (const [sub, rows] of bySub) {
    lines.push(`## ${sub}`);
    for (const row of rows) {
      if (!row.ok) {
        lines.push(`- ❌ \`${row.query}\` — FAILED (${row.error.code}: ${row.error.message})`);
        continue;
      }
      lines.push(`- 🔍 \`${row.query}\` (${row.provider}, ${row.results.length} hits)`);
      if (row.answer) lines.push(`  - **Provider answer:** ${trunc(row.answer, 600)}`);
      for (const r of row.results.slice(0, 4)) {
        lines.push(`  - [${r.n}] **${r.title}**${r.date ? ` _(${r.date})_` : ''}`);
        lines.push(`    ${r.url}`);
        const snip = trunc(r.content, 500);
        if (snip) lines.push(`    ${snip}`);
      }
    }
    lines.push('');
  }

  lines.push('## Still unknown');
  lines.push('- No LLM was available to check the evidence against the objective. Nothing here has been verified, cross-checked, or reconciled.');
  const failed = ledger.failedRows;
  if (failed.length) {
    lines.push(`- ${failed.length} search(es) failed outright: ${failed.map(f => '`' + f.query + '`').join(', ')}`);
  }

  return lines.join('\n');
}

function trunc(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
