// Output rendering for surf-ai.
//
// The consumer is an AI coding agent reading stdout, so the default is lean:
// the answer, the numbered sources it cites, and one footer line of run
// metadata. The coverage table and per-query detail are opt-in (--ledger),
// because in the common case they are tokens the agent pays for and ignores.
//
// ONE thing is never opt-in: what the run did NOT settle. The tool's promise is
// that it clears its doubts before answering, so a run that answers with
// queries still in the frontier, or with the analyst's own open points
// unresolved, has to say so — and say how many — in the output the agent
// actually reads. Behind --ledger, `stop_reason: "resolved"` was reaching the
// reader as "resolved" while eight questions had never been asked.

export function renderMarkdown(result, { ledger: showLedger = false } = {}) {
  const { answer, ledger, stats, diagnostics, rounds, stop_reason, mode, elapsed_ms } = result;
  const parts = [String(answer || '').trim()];

  const open = openQuestions(result);
  if (open.length) {
    parts.push('');
    parts.push(...open);
  }

  if (stats.sources > 0) {
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('## Sources');
    parts.push(ledger.sourcesText());
  }

  if (showLedger) {
    parts.push('');
    parts.push('## Research ledger');
    parts.push('');
    parts.push(ledger.tableMarkdown());
    // The open points themselves are printed above, with or without --ledger.
    // What the deepening loop chose NOT to search, and why. A frontier that
    // silently drops candidates is indistinguishable from one that never had
    // them, and the difference matters when judging coverage.
    if (result.frontier) {
      const f = result.frontier;
      const pending = Number(f.pending) || 0;
      const closed = Array.isArray(f.closed_branches) ? f.closed_branches.length : 0;
      parts.push('');
      parts.push(
        `**Frontier:** ${pending} quer${pending === 1 ? 'y' : 'ies'} still queued · ` +
        `${closed} branch(es) closed · ${Number(f.rejected_total) || 0} candidate(s) rejected`
      );
      if (f.rejected && f.rejected.length) {
        parts.push('');
        parts.push('| Rejected candidate | Why |');
        parts.push('|---|---|');
        for (const r of f.rejected.slice(0, 15)) {
          parts.push(`| ${cell(r.q)} | ${cell(r.reason)} |`);
        }
      }
    }
  }

  parts.push('');
  parts.push('---');
  parts.push(runFooter({ mode, rounds, stats, diagnostics, stop_reason, elapsed_ms }));

  // The footer's last line is "Stopped because: <reason>", and the reason comes
  // from the analyst, which is exactly the thing that says "resolved" while the
  // frontier is full. Qualify it where a skimmer lands, not only at the top.
  const pending = pendingCount(result);
  if (pending > 0) {
    parts.push('');
    parts.push(
      `_…and it stopped with ${pending} quer${pending === 1 ? 'y' : 'ies'} still queued. ` +
      'See **Open questions** above._'
    );
  }

  return parts.join('\n');
}

/**
 * The doubts the run did not clear, as markdown lines.
 *
 * Returns [] only when there is genuinely nothing open — an exhausted frontier
 * and no open point is the single case where saying nothing is honest.
 */
function openQuestions(result) {
  const f = (result && result.frontier) || null;
  const pending = pendingCount(result);
  const points = result && result.analysis && Array.isArray(result.analysis.open_points)
    ? result.analysis.open_points.map(oneLine).filter(Boolean)
    : [];
  if (pending <= 0 && !points.length) return [];

  const out = ['---', '', '## Open questions', ''];

  if (pending > 0) {
    out.push(
      `> ⚠ **This run answered with ${pending} quer${pending === 1 ? 'y' : 'ies'} still queued.** ` +
      'The frontier was not exhausted — those searches were planned and never run, ' +
      'so the answer above is the best reading of a partial sweep.'
    );
    const queued = queuedQueries(f);
    if (queued.length) {
      out.push('');
      out.push('Planned and never run:');
      for (const q of queued.slice(0, 10)) out.push(`- ${q}`);
      if (queued.length > 10) out.push(`- …and ${queued.length - 10} more`);
    }
  }

  if (points.length) {
    if (pending > 0) out.push('');
    out.push('**Open points recorded by the analyst:**');
    for (const p of points) out.push(`- ${p}`);
  }

  if (pending > 0) {
    out.push('');
    out.push('_Re-run with `--ledger` for the coverage table and the rejected candidates._');
  }
  return out;
}

/** Queries admitted to the frontier and never run. 0 when there is no snapshot. */
function pendingCount(result) {
  const f = (result && result.frontier) || null;
  const n = f ? Number(f.pending) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The queries still sitting in the frontier, when the snapshot carries them.
 *
 * frontier.toJSON() reports the count and not the nodes today, so this is
 * normally empty and the block above prints the count alone. It is written
 * this way so that naming the unasked questions costs nothing the day the
 * snapshot grows the list.
 */
function queuedQueries(f) {
  const raw = (f && (f.pending_queries || f.queued)) || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(n => oneLine(typeof n === 'string' ? n : (n && n.q))).filter(Boolean);
}

/** Collapse to one line: nothing interpolated here may open a markdown block. */
function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

/**
 * One markdown table cell. A raw `|` in an LLM-written query or a frontier
 * reason shifts the columns of the row it lands in; `&#124;` renders as a pipe
 * and leaves no delimiter behind. (ledger.mjs keeps its own copy of this rule
 * for its own table — neither file exports it, on purpose.)
 */
function cell(v) {
  return oneLine(v).replace(/\|/g, '&#124;');
}

export function runFooter({ mode, rounds, stats, diagnostics, stop_reason, elapsed_ms }) {
  const bits = [
    `surf-ai \`${mode}\``,
    `${rounds} wave${rounds === 1 ? '' : 's'}`,
    `${stats.queries} quer${stats.queries === 1 ? 'y' : 'ies'} (${stats.failed} failed)`,
    `${stats.sources} source${stats.sources === 1 ? '' : 's'}`,
    `${(elapsed_ms / 1000).toFixed(1)}s`,
  ];
  const model = diagnostics.llm_calls.length ? diagnostics.llm_calls[diagnostics.llm_calls.length - 1].model : null;
  if (model) bits.push(`model \`${model}\``);
  const cost = diagnostics.llm_calls.reduce((s, c) => s + (Number(c.cost) || 0), 0);
  if (cost > 0) bits.push(`llm $${cost.toFixed(5)}`);
  if (stats.credits) bits.push(`${stats.credits} Brave request${stats.credits === 1 ? '' : 's'}`);
  let line = `_${bits.join(' · ')}_`;
  if (diagnostics.degraded.length) {
    line += `\n\n> ⚠ Degraded stage${diagnostics.degraded.length === 1 ? '' : 's'}: ` +
      diagnostics.degraded.map(d => `**${d.stage}** (${d.reason})`).join('; ');
  }
  // Models sometimes emit padded/soft-wrapped prose; collapse it so the footer
  // stays one clean line.
  const why = String(stop_reason || 'unknown').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  line += `\n\n_Stopped because: ${why}._`;
  return line;
}

export function renderJson(result) {
  return {
    operation: 'surf-ai',
    mode: result.mode,
    answer: result.answer,
    synthesized: result.synthesized,
    rounds: result.rounds,
    waves: result.waves ?? result.rounds,
    frontier: result.frontier || null,
    stop_reason: result.stop_reason,
    plan: result.plan,
    analysis: result.analysis,
    sources: result.ledger.sourcesList(),
    ledger: result.ledger.toJSON(),
    diagnostics: result.diagnostics,
    elapsed_ms: result.elapsed_ms,
  };
}
