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
//   · A rejected candidate is RECORDED, never silently dropped — but the
//     record is an AUDIT, not a life sentence. Only a query that was actually
//     ADMITTED bars its own key forever; a candidate turned away for a
//     CIRCUMSTANTIAL reason (too deep for the wave it arrived in, priority
//     below the floor at the time, its branch closed) may come back when the
//     circumstance changes. Blacklisting those was how the loop refused a
//     legitimate question and then reported it as a duplicate.
//   · One node is one closed question. Two questions in one node produce an
//     answer that closes neither.
//   · The wave width is a hard ceiling, never a target. Running fewer nodes
//     because the frontier is thin is correct behaviour, not underuse.

/**
 * Normalised token SEQUENCE, used for near-duplicate detection across rounds.
 *
 * The costs here are asymmetric, and that asymmetry decides every choice in
 * this function. A key that is too LOOSE costs one repeated Brave request. A
 * key that COLLIDES refuses a legitimate question and then records the refusal
 * as "duplicate" — so the run report tells the user their question was already
 * asked when it never was. The second failure is invisible to the user, so the
 * key is built to never collide, and tolerates being loose.
 *
 * Two properties are load-bearing:
 *
 *   · TOKEN ORDER IS KEPT. The order of a relation is its content:
 *     "docker faster than podman" and "podman faster than docker" are opposite
 *     questions, and "migrate from postgres to mysql" is not its own reverse.
 *     Sorting the tokens made each of those pairs one key.
 *   · SHORT TOKENS ARE KEPT. Languages and tools have short names — Go, R,
 *     C++ (which normalises to "c") — so dropping <=2-char tokens collapsed
 *     "Go vs Rust performance" and "C++ vs Rust performance" into one query.
 *     Keeping every token also makes the old digit exception unnecessary:
 *     "gpt 4 pricing" and "gpt 5 pricing" stay distinct because 4 and 5 are
 *     still there, not because of a carve-out.
 *
 * A query with no token longer than two characters and no digit anywhere
 * ("a an of to in on") names no subject at all. It gets the empty key, and
 * admit() refuses it as content-free instead of spending a request on filler.
 *
 * No filler-word list is applied, and that omission is deliberate: dropping
 * words like "the", "for" or "and" before hashing makes MORE different
 * questions share a key — the exact failure above. The looseness it leaves
 * behind (prefixing one filler word evades the dedup, for the price of a
 * single request) is accepted debt, tracked as BUG-35 in
 * test/adversarial/loop-frontier.mjs.
 */
export function queryKey(q) {
  const tokens = String(q || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  // No content word anywhere -> no key. This is the ONLY place shortness still
  // decides anything, and it judges the whole query, never a single token.
  if (!tokens.some(w => w.length > 2 || /\d/.test(w))) return '';
  return tokens.join(' ');
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
    this.admittedKeys = new Set(); // keys that were ADMITTED — the only permanent bar
    this.usedIds = new Set();    // every id handed to an admitted node, ever
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
    // Only an ADMITTED key is a duplicate. `seen` also holds every candidate
    // that was ever turned away, and those refusals were circumstantial.
    if (this.admittedKeys.has(key)) return this.#reject(node, 'duplicate of a query already admitted');
    if (node.depth > this.maxDepth) return this.#reject(node, `deeper than the depth cap (${this.maxDepth})`);
    if (this.closed.has(node.sub)) return this.#reject(node, `branch '${node.sub}' is already closed`);
    if (node.priority < this.minPriority) return this.#reject(node, `priority ${node.priority} below the admission threshold`);

    // One id is one query, for the whole run: the ledger table, the [id]
    // headers in the digest and the parent map are all keyed by it, so a
    // reused id would silently merge two different queries into one row.
    node.id = this.#uniqueId(node.id);
    this.usedIds.add(node.id);
    this.seen.add(key);
    this.admittedKeys.add(key);
    this.nodes.push(node);
    this.nodes.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    return { admitted: true, node };
  }

  #reject(node, reason) {
    // Record it, but do NOT bar the key. `seen` is the audit counter — what was
    // ever proposed — while `admittedKeys` is the bar, and only admission fills
    // that. Barring on rejection meant a query refused for being too deep in
    // wave 2 could never be asked at depth 0 in wave 3, and the refusal came
    // back labelled "duplicate", which was a lie. Re-proposing a still-barred
    // query is cheap: it is refused again here, without a request, and the
    // orchestrator's dry-spell counter still ends a loop that only repeats.
    const key = queryKey(node.q);
    if (key) this.seen.add(key);
    this.rejected.push({ q: node.q, sub: node.sub, depth: node.depth, reason });
    return { admitted: false, reason };
  }

  /** The requested id when it is free, a suffixed variant when it is taken. */
  #uniqueId(wanted) {
    const base = String(wanted == null ? '' : wanted).trim() || nextId('n');
    if (!this.usedIds.has(base)) return base;
    let n = 2;
    while (this.usedIds.has(`${base}#${n}`)) n += 1;
    return `${base}#${n}`;
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

  /**
   * Compact snapshot for the run report.
   *
   * PURE ADDITION ONLY. render.mjs and the ledger already read `pending`,
   * `closed_branches`, `rejected`, `rejected_total` and `seen_queries` by
   * name; nothing here may be renamed or dropped.
   *
   * `pending_queries` exists because the COUNT alone is half an answer. "This
   * run answered with 8 queries still queued" tells the user a doubt was left
   * open but never WHICH one, and a doubt you cannot name is a doubt you
   * cannot go and settle. The nodes are kept sorted by priority, so the names
   * published first are the ones the run most wanted to ask.
   *
   * It is the same class of data the snapshot has always published in
   * `rejected[].q`: query text written by the planner or the analyst. It is
   * never a URL, so it carries none of the embedded-credential risk that
   * canonicalUrl handles — and any secret a user pastes into the question
   * already reaches Brave and the ledger long before this line runs.
   */
  toJSON() {
    const PENDING_CAP = 50;
    const pending_queries = this.nodes.slice(0, PENDING_CAP).map(n => n.q);
    const omitted = this.nodes.length - pending_queries.length;
    // Never truncate in silence — that is the exact sin this pass is undoing.
    // The notice rides INSIDE the array so a consumer that only prints the
    // list still shows the cut, and the count is published as a field for one
    // that reads the shape.
    if (omitted > 0) {
      pending_queries.push(`… and ${omitted} more queued quer${omitted === 1 ? 'y' : 'ies'} not listed`);
    }
    return {
      pending: this.nodes.length,
      pending_queries,
      pending_queries_omitted: omitted > 0 ? omitted : 0,
      closed_branches: [...this.closed],
      rejected: this.rejected.slice(0, 50),
      rejected_total: this.rejected.length,
      seen_queries: this.seen.size,
    };
  }
}
