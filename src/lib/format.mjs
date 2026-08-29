// Markdown formatters that consume the NORMALIZED result envelope:
//   { provider, operation, data, usage, latency_ms, raw }

import { trunc } from './flags.mjs';

const MAX_RAW = Number(process.env.SURF_MAX_CONTENT_CHARS || process.env.TAVILY_MAX_CONTENT_CHARS) || 1500;

function footer(envelope) {
  const c = envelope.usage && envelope.usage.credits;
  const bits = [`provider: ${envelope.provider}`];
  if (envelope.latency_ms != null) bits.push(`${envelope.latency_ms}ms`);
  if (c != null) bits.push(`credits: ${c}`);
  return `\n_${bits.join(' · ')}_\n`;
}

export function fmtSearch(envelope) {
  const r = envelope.data;
  let md = `# Search: ${r.query || ''}\n\n`;
  if (r.answer) md += `**Answer:** ${r.answer}\n\n`;
  (r.results || []).forEach((it, i) => {
    md += `## [${i + 1}] ${it.title || it.url}\n${it.url}\n`;
    if (it.score != null) md += `*score: ${typeof it.score === 'number' ? it.score.toFixed(2) : it.score}*\n`;
    // page_age (ISO) when Brave has it, else the human `age` string. Only the
    // ISO form ever reaches an LLM prompt; this is the human-facing renderer.
    const when = it.published_date || it.age_text;
    if (when) md += `*published: ${when}*\n`;
    md += `\n${trunc(it.content || '', MAX_RAW)}\n\n`;
    if (it.raw_content) {
      md += `<details><summary>raw</summary>\n\n${trunc(it.raw_content, 3000)}\n\n</details>\n\n`;
    }
  });
  md += footer(envelope);
  return md;
}

export function formatFor(envelope) {
  switch (envelope.operation) {
    case 'search': return fmtSearch(envelope);
    default: return JSON.stringify(envelope, null, 2);
  }
}
