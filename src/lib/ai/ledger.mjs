// The surf-ai research ledger.
//
// Everything the pipeline learns lands here: one row per query (successes AND
// failures — a dropped query is a lie about coverage), plus a deduplicated,
// numbered source index that the synthesis cites with [n] markers.
//
// The digest is what actually goes into the LLM's context, so this file owns
// the truncation policy. It is budget-aware in two directions: per result, and
// per whole digest — a single 400 KB page must never blow the context and
// starve the other 20 results.

const STRIP_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'ref', 'ref_src', 'source', 'mc_cid', 'mc_eid',
];

/** Canonical form used for dedupe: no tracking params, no fragment, no trailing slash. */
export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const p of STRIP_PARAMS) u.searchParams.delete(p);
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

function clean(s, n) {
  if (typeof s !== 'string') return '';
  // Collapse the whitespace soup that extracted page text usually is; it wastes
  // tokens and hurts nothing to normalize.
  const t = s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export class Ledger {
  constructor() {
    this.rows = [];          // one per executed query
    this.sourceIndex = new Map(); // canonical url -> { n, url, title, date, providers:Set }
    this.seenQueries = new Set();
  }

  /** Has this exact query already been run? Used to stop round-over-round repeats. */
  hasQuery(q) {
    return this.seenQueries.has(normQuery(q));
  }

  markQuery(q) {
    this.seenQueries.add(normQuery(q));
  }

  /** Record a successful search. `envelope` is a dispatch() result. */
  addSuccess(round, item, envelope) {
    const data = (envelope && envelope.data) || {};
    const results = Array.isArray(data.results) ? data.results : [];
    const kept = results.map(r => {
      const url = canonicalUrl(r.url);
      const entry = this.#indexSource(url, r);
      return {
        n: entry ? entry.n : null,
        url,
        title: r.title || url,
        date: r.published_date || null,
        score: r.score,
        content: r.content || r.raw_content || '',
      };
    });
    this.rows.push({
      round, id: item.id, sub: item.sub, category: item.category || null,
      parent: item.parent || null, depth: item.depth ?? 0, kind: item.kind || 'breadth',
      query: item.q, ok: true,
      provider: envelope.provider,
      latency_ms: envelope.latency_ms,
      credits: (envelope.usage && envelope.usage.credits) || 0,
      answer: data.answer || null,
      results: kept,
    });
    this.markQuery(item.q);
  }

  /** Record a failed search. Failures are rows too — never dropped. */
  addFailure(round, item, error) {
    this.rows.push({
      round, id: item.id, sub: item.sub, category: item.category || null,
      parent: item.parent || null, depth: item.depth ?? 0, kind: item.kind || 'breadth',
      query: item.q, ok: false,
      error: {
        code: (error && (error.code || error.name)) || 'Error',
        message: (error && error.message) || String(error),
      },
      results: [],
    });
    this.markQuery(item.q);
  }

  #indexSource(url, r) {
    if (!url) return null;
    const existing = this.sourceIndex.get(url);
    if (existing) {
      if (!existing.date && r.published_date) existing.date = r.published_date;
      return existing;
    }
    const entry = {
      n: this.sourceIndex.size + 1,
      url,
      title: r.title || url,
      date: r.published_date || null,
    };
    this.sourceIndex.set(url, entry);
    return entry;
  }

  /** Canonical sources first seen in this round — the saturation signal. */
  newSourcesInRound(round) {
    const earlier = new Set();
    let count = 0;
    for (const row of this.rows) {
      for (const r of row.results || []) {
        if (row.round < round) earlier.add(r.url);
        else if (row.round === round && !earlier.has(r.url)) { earlier.add(r.url); count++; }
      }
    }
    return count;
  }

  get okRows() { return this.rows.filter(r => r.ok); }
  get failedRows() { return this.rows.filter(r => !r.ok); }

  stats() {
    const credits = this.rows.reduce((s, r) => s + (r.credits || 0), 0);
    return {
      queries: this.rows.length,
      succeeded: this.okRows.length,
      failed: this.failedRows.length,
      sources: this.sourceIndex.size,
      credits,
    };
  }

  /** Numbered source list for the synthesis prompt and the printed footer. */
  sourcesText() {
    const lines = [];
    for (const e of this.sourceIndex.values()) {
      lines.push(`[${e.n}] ${e.title} — ${e.url}${e.date ? ` (${e.date})` : ''}`);
    }
    return lines.join('\n') || '(no sources retrieved)';
  }

  sourcesList() {
    return [...this.sourceIndex.values()];
  }

  /**
   * Evidence digest for an LLM stage.
   *
   * @param {object} o
   * @param {number} [o.perResult=900]     max chars of snippet per result
   * @param {number} [o.maxResults=6]      max results kept per query
   * @param {number} [o.maxChars=110000]   hard ceiling on the whole digest
   * @param {number} [o.sinceRound]        only include rows from this round on
   */
  digest({ perResult = 900, maxResults = 6, maxChars = 110_000, sinceRound = 0 } = {}) {
    const parts = [];
    let used = 0;
    let truncatedAt = null;

    const rows = this.rows.filter(r => r.round >= sinceRound);
    for (const row of rows) {
      const lineage = `depth ${row.depth ?? 0}${row.parent ? ` · follows [${row.parent}]` : ''} · ${row.kind || 'breadth'}`;
      const head = row.ok
        ? `### [${row.id}] ${row.query}\n(sub: ${row.sub || '—'} · ${lineage} · category: ${row.category || '—'} · wave ${row.round})`
        : `### [${row.id}] ${row.query}\n(sub: ${row.sub || '—'} · ${lineage} · wave ${row.round}) — SEARCH FAILED: ${row.error.code}: ${row.error.message}`;

      const body = [];
      if (row.answer) body.push(`Provider answer: ${clean(row.answer, 700)}`);
      for (const r of row.results.slice(0, maxResults)) {
        const snippet = clean(r.content, perResult);
        body.push(
          `- [${r.n}] ${r.title}${r.date ? ` (${r.date})` : ''}\n  ${r.url}\n  ${snippet || '(no snippet returned)'}`
        );
      }
      const block = `${head}\n${body.join('\n') || '(no results)'}\n`;

      if (used + block.length > maxChars) {
        truncatedAt = row.id;
        break;
      }
      parts.push(block);
      used += block.length;
    }

    let out = parts.join('\n');
    if (truncatedAt) {
      out += `\n(evidence truncated at query ${truncatedAt} to fit the context budget; ` +
             `${rows.length - parts.length} more quer${rows.length - parts.length === 1 ? 'y' : 'ies'} not shown)`;
    }
    return out || '(no evidence gathered)';
  }

  /** Markdown table of every query — the auditable coverage record. */
  tableMarkdown() {
    const lines = [
      '| Wave | Depth | Sub | Query id | Kind | Parent | Status | Top source |',
      '|---|---|---|---|---|---|---|---|',
    ];
    for (const r of this.rows) {
      const top = r.ok && r.results[0]
        ? `[${r.results[0].n}] ${trunc(r.results[0].title, 60)}`
        : '—';
      const status = r.ok ? `OK (${r.results.length} hits)` : `FAILED: ${r.error.code}`;
      lines.push(
        `| ${r.round} | ${r.depth ?? 0} | ${r.sub || '—'} | ${r.id} | ${r.kind || 'breadth'} | ${r.parent || '—'} | ${status} | ${top} |`
      );
    }
    return lines.join('\n');
  }

  /** Plain JS object for --json output. */
  toJSON() {
    return {
      stats: this.stats(),
      sources: this.sourcesList(),
      rows: this.rows,
    };
  }
}

function normQuery(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function trunc(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
