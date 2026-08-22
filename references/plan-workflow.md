# surf-plan-agent-skill workflow — deeper docs

This file expands on the workflow defined in `skills/surf-plan-agent-skill/SKILL.md`.
It's for humans reviewing the methodology, not for the agent (which only
reads SKILL.md).

## v7.0.0 — one skill, two depths

Through v4.2.0 this project shipped two separate planning skills:
`surf-plan-agent-skill` (research-grounded, 6 phases) and `surf-deep-plan-skill`
(the same, plus a mandatory front-loaded ambiguity sweep and a second gate
lock). v5.0.0 folds the second into the first as an internal **Deep mode**
that the skill routes into automatically — see "Mode Decision" below. There
is no longer a separate skill file or trigger-phrase competition between the
two; there is one skill and a decision point.

## The research gate (v4.1.0, unchanged in spirit)

The skill's core invariant: **no plan reaches the user — through any
channel — without completed web research.** "Any channel" covers the plan
file, chat text, and crucially the plan-approval tools of agent harnesses
(Claude Code's `ExitPlanMode` and equivalents).

This was added because the v4.0.x skill had a hole: its only research
mechanism was the `surf-research-skill` CLI via the Bash tool, and harness
plan modes (the very modes that present a plan for approval) typically
**block Bash entirely**. The agent would trigger the skill, find Bash
blocked, silently skip research, and present an unresearched plan for
approval — defeating the skill's whole purpose.

The gate is enforced three ways, following Anthropic's skill-authoring best
practices (verifiable intermediate outputs + checklists):

1. A **progress checklist** the agent copies into its response and updates
   as it works — skipped phases are visible to the user.
2. A **Research Ledger** section required in every plan: one row per query
   (phase, layer, query string, which footnotes used it). Every Decision
   footnote must trace to a ledger row.
3. **Layered fallback** (below) so "the tool was blocked" is never a reason
   to skip — there is always a defined next step.

Deep mode adds a second lock on top: the **Ambiguity Register** must be
complete (every item Answered or explicit ASSUMPTION) before a plan may be
proposed. See "Deep mode" below.

## Research layers

| Layer | Mechanism | When |
|---|---|---|
| A | `surf-research-skill` CLI via Bash | Default. Multi-provider, key rotation, batching, parallel fan-out. |
| A-manual | raw `surf-research-skill search/extract/crawl/map` via Bash | When `surf-ai` is unavailable or you need raw results without synthesis. |
| B | Harness-native `WebSearch` / `WebFetch` | Bash unavailable, denied, or blocked by mode (plan mode); CLI missing or all keys burned. |
| C | None | Halt: user explicitly chooses between aborting and an "NOT WEB-RESEARCHED"-labeled plan. |

The layer is resolved in Phase 0 and recorded in the ledger. Mid-flow Layer A
failures (burned key, timeout, denied call) downgrade to B for the remaining
calls — research never silently stops.

## Delegated research (subagent/swarm)

When the harness exposes a **subagent tool** (`Agent`, `Task`, `AgentSwarm`,
or equivalent), the research in **Phases 3/4D/6** (and the per-question
searches in **Phases 5/5D**) MAY be delegated to a research subagent or a
1-per-angle swarm instead of running inline. Without a subagent tool, all
research runs inline via **Layer A/B** as described above — delegated mode is
an option, never a requirement.

### How it works

1. **Dispatch:** for each research batch, hand off to a subagent (one per
   Register category in Deep mode's Phase 4D; one per question in Phases
   5/5D) with the brief contract from `surf-research-agent-skill`'s delegated
   research section (objective, source categories, scope boundary, validated
   return format with ledger rows + confirmed claims + detected doubts).
2. **Receive:** the subagent returns validated findings (2+ sources per key
   claim, dates checked, contradictions flagged) plus ledger rows and any new
   doubts it surfaced.
3. **Review:** the main agent — still the interviewer — reviews the returns.
   New doubts enter the **Ambiguity Register** (Deep mode) or become the next
   wave's targets.
4. **Iterate:** if new doubts survive review and you are under the **3-wave
   cap** (inherited from `surf-research-agent-skill` rule 7 — delegated mode does
   NOT raise it), re-brief and dispatch again. Stop when saturated or the cap
   is hit; record remaining gaps.

### Fallback

No subagent tool available? Run the research inline via Layer A or B as the
current Phases 3/4D/5/5D/6 already prescribe — the gate, ledger, Register,
and lock rules apply exactly as they do today. Delegated mode adds throughput
without removing the existing path.

## Plan-approval modes (Claude Code plan mode)

Claude Code's plan mode allows Read, Glob, Grep, WebSearch, WebFetch, and
AskUserQuestion, but blocks Bash, Write, and Edit. The skill's behavior
there:

- All research (and, in Deep mode, the ambiguity sweep) runs **before**
  `ExitPlanMode`, using Layer B for all searches (WebSearch/WebFetch are
  read-only and permitted).
- The plan submitted for approval embeds Decisions-with-citations and the
  Research Ledger (Deep mode also embeds the Ambiguity Register) — the user
  approves evidence, not vibes.
- The plan **file** is written immediately after approval, when Write is
  unblocked.

## Phase 0 — resolve the research layer

Why: the old behavior ("halt if `surf-research-skill --version` fails") was
brittle — it turned every Bash restriction into a dead end, which agents
resolved by abandoning the skill. Now Phase 0 picks the best available layer
and only Layer C (nothing at all) halts, with the user making the call.

How: try `surf-research-skill --version` via Bash → Layer A. Bash
blocked/missing → check for WebSearch/WebFetch → Layer B. Neither → Layer C.

## Phase 1 — project discovery

Why: plans that skip this duplicate existing code. ~5 minutes of reading
saves hours of integration pain.

How:
1. `CLAUDE.md`, `AGENTS.md`, `README.md` — house style + constraints.
2. Package manifest — language, framework, deps.
3. Glob the source tree (2 levels deep).
4. Identify 2–3 existing patterns / utilities the new feature should reuse.
5. Note relevant configs (eslint, tsconfig, docker, ci).

Output: agent's mental model of "what already exists" + file paths, plus a
1-line restatement of the goal that feeds Phase 2's decision.

## Phase 2 — Mode Decision (new in v7.0.0)

Why: the old world made the user (or the calling agent) pick between
`surf-plan-agent-skill` and `surf-deep-plan-skill` up front, based on trigger
phrases — easy to get wrong, and it meant the ambiguity sweep was
all-or-nothing at the *skill-selection* level rather than a judgment made
*after* actually reading the project. Now one skill reads the project first,
then decides.

How: go **Deep** if the user explicitly asked ("raise all my doubts",
"exhaustive plan", "levante todas as dúvidas"), the work is hard to reverse
(migration, auth model, public API, billing), Phase 1 surfaced multiple real
structural unknowns, or a "two plausible implementations" sketch diverges
meaningfully. Otherwise stay **Normal**. State the decision and the one-line
reason before continuing — this is itself a checklist item, so a silent
default can't hide.

## Normal mode phases

### Baseline web research (REQUIRED)

Why: ground the plan in 2026 best practices, not 2024 training data.

How: ONE batched `surf-research-skill search` with 3 queries (Layer A) or
the same 3 queries as parallel WebSearch calls (Layer B). Distill:
- 3 dominant approaches
- 2–3 common mistakes
- 1–2 security/performance gotchas

Cost (Layer A): ~6 credits (Tavily) + ~10 s. Acceptable for any non-trivial
plan.

### Open the conversation

Why: the user needs to see you've done your homework before they answer
questions.

How: ≤8 lines. What you read + what the web says + how many questions you
have.

### Clarifying questions (MAX 5)

Why: even after research, certain decisions require the user's preference
(e.g., "Redis or Postgres for the queue?", "do we need multi-tenancy from
day one?").

How: for each question, a targeted `surf-research-skill search --max 2`
(Layer A) or one WebSearch call (Layer B) first, then AskUserQuestion with
options informed by the search. Max 5 total.

Anti-pattern: asking the user to choose between options that the agent just
made up. Search first; pick options from real approaches. See "How to
research and resolve a technical doubt" in SKILL.md for the full query-craft
and contradiction-resolution protocol.

### Synthesis research (REQUIRED)

Why: verify the user's choices against the very-latest state of the art.
Catches "you chose X but X v2 dropped support for Y last month".

How: ONE batched search with the user's chosen approach. ~6 credits. If
contradictions appear, flag them BEFORE writing the plan. After this, the
research lock opens — and only after.

## Deep mode phases (replaces the old separate surf-deep-plan-skill)

### Ambiguity sweep (→ Ambiguity Register)

Why: a plan built on an unspoken assumption fails exactly where the
assumption was wrong. This is the differentiator vs Normal mode.

How: walk a fixed taxonomy (Scope, Architecture, Data, Security,
Performance, Deployment, Constraints, Edge cases, Non-functional) and ask
"is anything here unspecified, vague, or assumed?" for each. Two detection
aids surface *real* gaps instead of invented ones:
- **EARS gap test** — write each requirement as "When `<trigger>`, the
  system shall `<behavior>`." An unfillable clause is an ambiguity.
- **Two-implementations test** — sketch 2 plausible implementations; where
  they'd diverge is a real ambiguity.

Record every doubt in the Register — completeness is the whole point of
this mode; don't stop early.

### Grounding (→ Research Ledger)

Why: every clarifying option presented to the user must be a real,
found approach — never invented.

How: for each ambiguity with an externally-verifiable answer, fan out
parallel research (one query per unknown × angle) via `search-parallel`.
See surf-research-agent-skill's fan-out protocol (ledger, dedup, gate) — this
reuses it directly rather than duplicating it.

### Clarify (higher volume than Normal)

Why: Deep mode's whole premise is surfacing everything before writing
anything, so more questions are expected and budgeted for.

How: group the Register by category, ask highest-information-gain
questions first, 3-5 options per question (each traced to a Ledger row),
cap ~5-7 per round, batch a second round if needed. Anything research can
safely settle → mark ASSUMPTION instead of asking, list for the user to
veto.

### Synthesis research + deliver

Same mechanics as Normal mode's synthesis phase, run against the final
choices. Both locks (ambiguity + research) must be satisfied before
delivery; the plan embeds both the Ambiguity Register and the Research
Ledger.

## Deliver the plan (both modes)

Why: a plan file is a contract. It's reviewable, executable, and auditable.
Chat history is none of those.

How: Markdown with the structure from SKILL.md. Required sections: Context,
(Ambiguity register — Deep mode only), Decisions, Files, Steps,
Verification, **Research ledger**, Assumptions & open items, References. In
plan-approval modes, the same content goes to the approval tool first and
the file is written right after approval.

Citations use Markdown footnote syntax `[^N]: [Title](URL)` — renders in
GitHub, GitLab, Bitbucket, Cursor, Plannotator, and most other viewers.

## Cost discipline

A typical **Normal** plan uses (Layer A):
- 1 batch (baseline): 3 queries, ~6 credits, ~10 s
- 3–5 targeted (clarify): 1 query each, ~5 credits, ~3 s each
- 1 batch (synthesis): 2–3 queries, ~5 credits, ~8 s

Total: ~15–20 credits, ~30 s of network time. On Tavily's free tier (1k
credits/month), that's ~50 plans per month for free.

A typical **Deep** plan adds the grounding fan-out on top: roughly 1 query
per Register item, run concurrently via `search-parallel` rather than
sequentially, so wall-clock cost stays low even though credit cost is
higher (proportional to the number of real ambiguities found — this mode
is reserved for when that cost is worth paying). Layer B costs nothing from
the surf budget either way (the harness pays for its own WebSearch).

## Anti-patterns explained

**Approval before research**
Presenting a plan via the approval tool and promising to "research during
implementation" inverts the skill: approval exists so the user reviews a
researched plan. The gate + ledger make this visible.

**"Bash was blocked, so I skipped the searches"**
A blocked layer is the trigger to use the next layer, never to skip. This
was the v4.0.x failure mode in plan mode.

**Deep mode on a routine 1-file plan / Normal mode on a high-stakes vague
request**
Both are Mode Decision failures — the first wastes the user's time on
ceremony they didn't need, the second ships an unexamined assumption on
work where it's expensive to be wrong.

**Fabricated ledger**
Queries the agent never ran / URLs it never saw. Worse than no plan — it
forges the evidence the user approves. The ledger maps footnotes to queries
precisely so this is auditable.

**Verbose research summary section**
A "Research Findings" section dumping every URL with snippet is noise — it
inflates the plan, distracts the executor, and ages instantly. Synthesize:
the plan has Decisions with footnotes + a compact ledger; that's the
research's role in the final document.

**Aesthetic questions**
"What color theme?" / "Should we name it FooBar or BarFoo?" — these aren't
planning questions. Defer to the execution phase.

**Single-source citations**
If every decision footnotes the same URL, the research was shallow.
Diversify: aim for 1 citation per major source category (vendor docs,
community blog, security advisory, benchmark, etc.).

**Plans without file paths**
"Update the controller layer" is not a plan, it's a wish. Phase 1 exists so
the plan can say `src/controllers/user.ts:42`.

**Surveys (>5 questions in Normal mode, >7 per round in Deep mode)**
Past that, the user fatigues and starts answering "whatever". If you
genuinely need more, the task is too big — slice it.

## Plan file conventions

- File name: `<slug>-<YYYYMMDD-HHMM>.md`. Slug is kebab-case, ≤50 chars.
- Slug collision: append `-2`, `-3`, etc.
- Title in `# Plan: ...` matches the slug.
- Footnote order: in the order they're first cited.
- URLs: full https links, no trackers or auth tokens.
- Code references: `path/to/file.ext:LINE` format, parseable by most IDEs.

## What surf-plan-agent-skill is NOT

- Not an execution engine. Once the plan is written, hand it to another
  tool/agent/human.
- Not a project manager. It's per-task, not multi-task.
- Not a code generator. It writes a plan, not code.
- Not a replacement for Plan Mode. Plan Mode is the harness's interactive
  approval flow; surf-plan-agent-skill is the research+evidence methodology that
  runs *inside* it (Layers make that possible). They complement.
- Not two skills anymore. Deep mode is a path through this one skill, not a
  separate trigger to remember.
