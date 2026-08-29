// Output rendering for surf-ai.
//
// The consumer is an AI coding agent reading stdout, so the default is lean:
// the answer, the numbered sources it cites, and one footer line of run
// metadata. The coverage table and per-query detail are opt-in (--ledger),
// because in the common case they are tokens the agent pays for and ignores.

export function renderMarkdown(result, { ledger: showLedger = false } = {}) {
  const { answer, ledger, stats, diagnostics, rounds, stop_reason, mode, elapsed_ms } = result;
  const parts = [String(answer || '').trim()];

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
    if (result.analysis && Array.isArray(result.analysis.open_points) && result.analysis.open_points.length) {
      parts.push('');
      parts.push('**Open points recorded by the analyst:**');
      for (const p of result.analysis.open_points) parts.push(`- ${p}`);
    }
    // What the deepening loop chose NOT to search, and why. A frontier that
    // silently drops candidates is indistinguishable from one that never had
    // them, and the difference matters when judging coverage.
    if (result.frontier) {
      const f = result.frontier;
      parts.push('');
      parts.push(
        `**Frontier:** ${f.pending} quer${f.pending === 1 ? 'y' : 'ies'} still queued · ` +
        `${f.closed_branches.length} branch(es) closed · ${f.rejected_total} candidate(s) rejected`
      );
      if (f.rejected && f.rejected.length) {
        parts.push('');
        parts.push('| Rejected candidate | Why |');
        parts.push('|---|---|');
        for (const r of f.rejected.slice(0, 15)) {
          parts.push(`| ${String(r.q).replace(/\|/g, '\\|')} | ${r.reason} |`);
        }
      }
    }
  }

  parts.push('');
  parts.push('---');
  parts.push(runFooter({ mode, rounds, stats, diagnostics, stop_reason, elapsed_ms }));

  return parts.join('\n');
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
