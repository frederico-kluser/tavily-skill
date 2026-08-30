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

/**
 * Canonical form used for dedupe: no credentials, no tracking params, no
 * fragment, no trailing slash.
 *
 * The credentials are not a dedupe concern, they are a disclosure one. Every
 * url that reaches this function is printed by sourcesText() and embedded in
 * the synthesis prompt, so a `https://user:token@host/…` — returned by a
 * provider, or pasted by the user — used to leave the process on stdout AND
 * inside a third-party LLM request. Strip them here, at the one chokepoint
 * every url passes through, rather than at each of the places that print one.
 */
export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    u.username = '';
    u.password = '';
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

  /**
   * Record a successful search. `envelope` is a dispatch() result.
   *
   * Nothing in here may throw. This runs while a wave is being accounted for,
   * so a single malformed result — a missing envelope, a `null` inside
   * data.results — used to abort the whole wave and lose the rows of every
   * sibling query that DID succeed.
   */
  addSuccess(round, item, envelope) {
    const env = (envelope && typeof envelope === 'object') ? envelope : {};
    const data = (env.data && typeof env.data === 'object') ? env.data : {};
    const results = Array.isArray(data.results) ? data.results : [];
    const kept = results.filter(r => r && typeof r === 'object').map(r => {
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
      provider: env.provider,
      latency_ms: env.latency_ms,
      credits: (env.usage && env.usage.credits) || 0,
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

  /**
   * Numbered source list for the synthesis prompt and the printed footer.
   *
   * One source per LINE, so a title carrying a newline — page titles do — must
   * be collapsed: otherwise source [7] becomes two entries and the model has a
   * dangling line to attribute a citation to.
   */
  sourcesText() {
    const lines = [];
    for (const e of this.sourceIndex.values()) {
      lines.push(`[${e.n}] ${oneLine(e.title)} — ${e.url}${e.date ? ` (${oneLine(e.date)})` : ''}`);
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
          `- ${citation(r.n)} ${r.title}${r.date ? ` (${r.date})` : ''}\n  ${r.url}\n  ${snippet || '(no snippet returned)'}`
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

  /**
   * Markdown table of every query — the auditable coverage record.
   *
   * Every cell goes through cell(). Titles come from the open web and sub ids
   * come from an LLM plan, so a `|` or a newline in either of them used to
   * shift the columns of one row or split it into two, and a coverage record
   * that renders wrong is not a coverage record.
   */
  tableMarkdown() {
    const lines = [
      '| Wave | Depth | Sub | Query id | Kind | Parent | Status | Top source |',
      '|---|---|---|---|---|---|---|---|',
    ];
    for (const r of this.rows) {
      const first = r.ok ? r.results[0] : null;
      const top = first ? `${citation(first.n)} ${trunc(first.title, 60)}` : '—';
      const status = r.ok ? `OK (${r.results.length} hits)` : `FAILED: ${r.error.code}`;
      lines.push(
        `| ${r.round} | ${r.depth ?? 0} | ${cell(r.sub || '—')} | ${cell(r.id)} | ${cell(r.kind || 'breadth')} | ${cell(r.parent || '—')} | ${cell(status)} | ${cell(top)} |`
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

/**
 * The citation marker for a result.
 *
 * A result with no url gets no source number, and `[null]` was being printed
 * straight into the synthesis prompt — a marker the model can and does copy
 * into the answer, pointing at a source that does not exist. Say plainly that
 * there is nothing to cite instead.
 */
function citation(n) {
  return Number.isInteger(n) ? `[${n}]` : '(no citable url)';
}

/** Collapse to one line. Titles come from the open web and carry newlines. */
function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

/**
 * One markdown table cell: no line break, no raw pipe, ever.
 *
 * `\|` is the markdown escape and renders correctly in GFM, but the literal
 * `|` is still there in the text, so anything that reads the row by splitting
 * on `|` still counts the wrong number of columns. `&#124;` renders as a pipe
 * and leaves no delimiter behind, which is the property this needs.
 */
function cell(v) {
  return oneLine(v).replace(/\|/g, '&#124;');
}
