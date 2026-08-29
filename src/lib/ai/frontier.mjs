// The deepening frontier.
//
// The old loop was flat: plan N queries, run them, ask the model for N more,
// run those. Nothing recorded WHY a query existed or WHAT it descended from,
// so "deeper" only ever meant "again". Depth was indistinguishable from
// repetition, and the only thing stopping it was a round counter.
//
// This is a priority frontier over a tree. Every query is a node that knows its
// parent and its depth, so the loop can reason about a BRANCH: it can tell that
// one sub-question is saturated while another is still thin, close the first,
// and spend the whole next wave on the second. That is what makes it deepening
// rather than re-searching.
//
// Three invariants, borrowed from the burst discipline in SKILL.md:
//   · A rejected candidate is RECORDED, never silently dropped. Forgetting
//     rejections is how a loop re-proposes the same dead query every round and
//     never converges.
//   · One node is one closed question. Two questions in one node produce an
//     answer that closes neither.
//   · The wave width is a hard ceiling, never a target. Running fewer nodes
//     because the frontier is thin is correct behaviour, not underuse.

/**
 * Normalised token set, used for near-duplicate detection across rounds.
 *
 * Short tokens are dropped as noise EXCEPT when they contain a digit. That
 * exception is load-bearing: version numbers are short, and collapsing them
 * would make "gpt 4 pricing" and "gpt 5 pricing" the same query — silently
 * refusing to research the second one.
 */
export function queryKey(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^\.+|\.+$/g, ''))
    .filter(w => w && (w.length > 2 || /\d/.test(w)))
    .sort()
    .join(' ');
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}${seq}`;
}

export function makeNode({ q, sub, category, parent = null, depth = 0, priority = 0.5, kind = 'breadth', id }) {
  return {
    id: id || nextId('n'),
    q: String(q || '').trim(),
    sub: sub || null,
    category: category || null,
    parent,
    depth,
    priority: clamp01(priority),
    kind: ['breadth', 'depth', 'verify'].includes(kind) ? kind : 'breadth',
    status: 'open',
  };
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

export class Frontier {
  constructor({ maxDepth = 3, minPriority = 0.15 } = {}) {
    this.nodes = [];             // open nodes, kept sorted by priority desc
    this.seen = new Set();       // every query key ever proposed, admitted or not
    this.rejected = [];          // {q, reason} — the audit trail
    this.closed = new Set();     // sub-question ids that are done
    this.branchMiss = new Map(); // sub → consecutive uninformative results
    this.maxDepth = maxDepth;
    this.minPriority = minPriority;
  }

  get size() { return this.nodes.length; }

  get openBranches() {
    const subs = new Set();
    for (const n of this.nodes) if (!this.closed.has(n.sub)) subs.add(n.sub || '_');
    return subs.size || 1;
  }

  /**
   * The admission gate. Deterministic on purpose: spending an LLM call to
   * decide whether to spend an LLM call is how a loop burns its budget on
   * bookkeeping and still goes to the round cap.
   */
  admit(node) {
    const key = queryKey(node.q);
    if (!node.q) return this.#reject(node, 'empty query');
    if (!key) return this.#reject(node, 'query has no content words');
    if (this.seen.has(key)) return this.#reject(node, 'duplicate of a query already proposed');
    if (node.depth > this.maxDepth) return this.#reject(node, `deeper than the depth cap (${this.maxDepth})`);
    if (this.closed.has(node.sub)) return this.#reject(node, `branch '${node.sub}' is already closed`);
    if (node.priority < this.minPriority) return this.#reject(node, `priority ${node.priority} below the admission threshold`);

    this.seen.add(key);
    this.nodes.push(node);
    this.nodes.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    return { admitted: true, node };
  }

  #reject(node, reason) {
    // Record BEFORE returning: a rejected query must never be proposable again,
    // or the analyst re-suggests it every round and the loop never converges.
    const key = queryKey(node.q);
    if (key) this.seen.add(key);
    this.rejected.push({ q: node.q, sub: node.sub, depth: node.depth, reason });
    return { admitted: false, reason };
  }

  /** Mark a sub-question finished; its pending nodes are dropped. */
  closeBranch(sub, reason = 'answered') {
    if (!sub) return;
    this.closed.add(sub);
    const before = this.nodes.length;
    this.nodes = this.nodes.filter(n => {
      if (n.sub !== sub) return true;
      this.rejected.push({ q: n.q, sub, depth: n.depth, reason: `branch closed: ${reason}` });
      return false;
    });
    return before - this.nodes.length;
  }

  /** A wave produced nothing new for this branch. Two in a row closes it. */
  noteMiss(sub) {
    if (!sub) return false;
    const n = (this.branchMiss.get(sub) || 0) + 1;
    this.branchMiss.set(sub, n);
    if (n >= 2) { this.closeBranch(sub, 'two consecutive waves added no new sources'); return true; }
    return false;
  }

  noteHit(sub) {
    if (sub) this.branchMiss.set(sub, 0);
  }

  /**
   * Take the next wave.
   *
   * `width` is the simultaneity ceiling (--sub-agents) and is never exceeded.
   * Within it:
   *   · per-branch quota — one hot branch cannot consume the whole wave while
   *     three others sit untouched;
   *   · a verification reserve, once anything is contested, so falsifying a
   *     shaky claim always outranks widening;
   *   · a depth ramp — early waves stay shallow to map the space, later waves
   *     prefer depth so the run actually descends instead of hovering.
   */
  popWave(width, { wave = 1 } = {}) {
    const w = Math.max(1, Math.floor(width) || 1);
    if (!this.nodes.length) return [];

    const branches = this.openBranches;
    const quota = Math.max(1, Math.ceil(w / branches) + 1);
    const reserveWanted = this.nodes.some(n => n.kind === 'verify')
      ? Math.max(1, Math.round(w * 0.2))
      : 0;

    const picked = [];
    const perBranch = new Map();

    const take = (pool) => {
      for (const n of pool) {
        if (picked.length >= w) break;
        if (picked.includes(n)) continue;
        const b = n.sub || '_';
        if ((perBranch.get(b) || 0) >= quota) continue;
        picked.push(n);
        perBranch.set(b, (perBranch.get(b) || 0) + 1);
      }
    };

    // 1. Verification first, up to the reserve. A contested claim left
    //    unverified poisons everything downstream of it.
    if (reserveWanted) {
      const verifies = this.nodes.filter(n => n.kind === 'verify').slice(0, reserveWanted);
      for (const n of verifies) {
        if (picked.length >= w) break;
        picked.push(n);
        const b = n.sub || '_';
        perBranch.set(b, (perBranch.get(b) || 0) + 1);
      }
    }

    // 2. The depth ramp. Early on, breadth is what tells you where depth is
    //    worth spending; later, breadth is just more of the same.
    const shallow = this.nodes.filter(n => n.kind !== 'verify' && n.depth <= 1);
    const deep = this.nodes.filter(n => n.kind !== 'verify' && n.depth >= 2);
    if (wave <= 2) { take(shallow); take(deep); }
    else { take(deep); take(shallow); }

    // 3. Whatever is left, by raw priority.
    take(this.nodes.filter(n => !picked.includes(n)));

    const pickedSet = new Set(picked);
    this.nodes = this.nodes.filter(n => !pickedSet.has(n));
    for (const n of picked) n.status = 'running';
    return picked;
  }

  /** Compact snapshot for the run report. */
  toJSON() {
    return {
      pending: this.nodes.length,
      closed_branches: [...this.closed],
      rejected: this.rejected.slice(0, 50),
      rejected_total: this.rejected.length,
      seen_queries: this.seen.size,
    };
  }
}
