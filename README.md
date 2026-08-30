<p align="center">
  <img src="logo.png" alt="surf-agent-skill logo" width="160" />
</p>

<h1 align="center">surf-agent-skill</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/surf-agent-skill"><img src="https://img.shields.io/npm/v/surf-agent-skill?style=flat-square&color=black" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/surf-agent-skill"><img src="https://img.shields.io/npm/dt/surf-agent-skill?style=flat-square&color=black" alt="downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/surf-agent-skill?style=flat-square&color=black" alt="MIT" /></a>
  <img src="https://img.shields.io/node/v/surf-agent-skill?style=flat-square&color=black" alt="node>=18" />
</p>

<p align="center">
  <strong>Autonomous web research for AI coding agents, on Brave Search and nothing else.</strong><br/>
  You state your situation; the CLI runs the whole loop — an LLM plans the queries, up to <code>--sub-agents</code> of them run at once against <strong>Brave</strong> (paced to your plan's real rate limit), the analyst says which branches are still thin, and the frontier <em>descends</em> into them instead of searching wider. Key rotation, model failover and a cross-process rate limiter live inside the CLI.<br/>
  <strong>No valid Brave key means exit 78 before anything runs.</strong> It answers from Brave, or it tells you why it cannot — it never quietly answers from somewhere else.
</p>

---

## surf-ai — the agent stops orchestrating research

Before surf-ai, the agent had to orchestrate research itself using a toolbox
of CLI commands and a detailed instruction file. **That loop now runs inside
the CLI.** The SKILL.md remains as the orchestrator's rulebook — what changed
is the agent's role, from researcher to briefer: describe its situation, and
pick one of two modes.

```
  agent: brief + mode
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ surf-ai                                                          │
│                                                                  │
│  0. GATE        a valid Brave key, or exit 78. Free to check,    │
│                 cached 7 days. Nothing below runs without it.    │
│  1. PLAN        DeepSeek V4 Pro (OpenRouter) → sub-questions     │
│                 + a category-diverse, PRIORITISED query array    │
│  2. WAVE        up to --sub-agents queries at once (default 10), │
│                 Brave only · multi-key rotation · per-key        │
│                 cooldowns · paced to the plan's real req/s       │
│  3. ANALYZE     DeepSeek reads the harvest → what is still open, │
│     (unlimit)   which branches are finished, is it saturated     │
│  4. DEEPEN      follow-ups enter a priority FRONTIER as tree     │
│     (unlimit)   nodes that know their parent and depth, so the   │
│                 next wave descends instead of widening           │
│  5. SYNTHESIZE  the answer, in the shape the agent asked for,    │
│                 cited against a numbered source index            │
│                                                                  │
│  normal  runs 0 → 1 → 2 → 5     (2 LLM calls, exactly one wave)  │
│  unlimit runs 0 → 1 → 2 → 3 → 4 → … → 5                          │
└──────────────────────────────────────────────────────────────────┘
    ↓
  finished, cited answer
```

```bash
surf-search-normal  "<question>" --task … --goal … --insights …   # 1 wave, fits the bash timeout
surf-search-unlimit "<question>" --sub-agents=10 --max-depth 3     # as many waves as needed
```

Almost everything that can go wrong is absorbed in there — 429s and their
backoff, burned keys, rate-limit pacing, a model that 404s, a rejected JSON
schema, a failed search, a reply that isn't valid JSON. **The CLI degrades and
labels the degradation; it never hands the agent an error to babysit.** No
OpenRouter key at all? It still searches and returns a cited evidence brief.

**One thing is deliberately NOT absorbed: a missing or invalid Brave key.**
That exits 78 before any work starts. There is nothing to degrade to, and
pretending otherwise is how v7 answered research questions out of Wikipedia at
exit 0.

```
surf-search-normal  ┐                ┌─▶ Brave /web/search
surf-search-unlimit ┼─▶ surf-ai ─────┤     the ONLY search backend
surf-research-skill ┘        │       │     multi-key · cross-process rate limiter
    ai --mode …              │       └─▶ (no fallback provider. none. by design.)
                             │
                             └─▶ OpenRouter ─▶ DeepSeek V4 Pro
                                               plan · analyze · synthesize

plan / design ──▶ surf-plan-agent-skill ──▶ Normal (research-grounded)
                          │         └ Deep  (+ ambiguity sweep, auto on
                          │                   vague/high-stakes work)
                          └─▶ calls surf-ai for its own research (cited)
```

| | |
|---|---|
| **Status** | v8.0.1 (npm) — **breaking**: Brave-only, see [the changelog](CHANGELOG.md) |
| **Install** | `npm i -g surf-agent-skill` (Linux · macOS · Windows) |
| **Search backend** | **Brave Search only.** No fallback provider, no keyless tier. A missing or invalid key is exit 78. |
| **Skills shipped** | `surf-research-agent-skill` (surf-ai) · `surf-plan-agent-skill` |
| **Bins shipped** | `surf`, `surf-search-normal`, `surf-search-unlimit`, `surf-research-skill`, `surf-plan-skill` |
| **Runtime** | Node ≥ 18. Zero npm deps. |
| **Storage** | `~/.config/surf/keys.json` (chmod 600) — the only place a key is ever written. Also caches the free validation verdict for 7 days. `OPENROUTER_API_KEY` is accepted from env, in memory. Library mode reads env/`.env` too ([Security](#security)). |
| **Supported agents** | Claude Code · GitHub Copilot CLI · Pi Coding Agent · OpenCode · Codex CLI |
| **Spec** | [Anthropic Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) |

## Quickstart (60 seconds)

```bash
npm i -g surf-agent-skill    # installs 2 skills + 5 bins (cross-OS)
surf                         # interactive: add your Brave key, validated LIVE and FREE
                             #   ✓ valid (brave, 340ms, free probe, 0 credits)
                             #   ✗ invalid key (Brave answers 422 SUBSCRIPTION_TOKEN_INVALID) — NOT saved
surf-research-skill ai-setup # the OpenRouter key that powers surf-ai (free to validate)

# Autonomous research — write the brief, get the answer:
surf-search-normal "does OpenRouter enforce strict json_schema on DeepSeek?" \
  --task "adding structured LLM calls to a CLI" \
  --goal "know which request fields to send and what silently degrades" \
  --insights "I think response_format.json_schema.strict works everywhere"

# Or ask an AI agent:
> make a plan for adding rate limiting to my Express API
# → surf-plan-agent-skill kicks in: reads the project, runs surf-ai research,
#   asks 3-5 researched questions, writes ~/.claude/plans/<slug>-<ts>.md
#
# Research is gated, not optional: the agent may not present a plan —
# including for plan-mode approval — before the research is done. When
# the harness blocks Bash (e.g. Claude Code plan mode), the skill falls
# back to the harness's native WebSearch/WebFetch instead of skipping.
```

### The brief is the whole job

| Flag | What goes in it | Why it changes the answer |
|---|---|---|
| `--task` | The work in progress | The planner drops queries that don't move it forward |
| `--goal` | The decision this research feeds | Becomes the objective the synthesis is graded against |
| `--insights` | What you already believe | The planner writes queries that could **falsify** each belief |
| `--deliverable` | The output shape you need | The synthesis matches it instead of writing an essay |

Long briefs go in a file: `--brief-file brief.json` with
`{"question","task","goal","insights","deliverable"}`.

### normal vs unlimit

| | `surf-search-normal` | `surf-search-unlimit` |
|---|---|---|
| Waves | Exactly 1 | Until resolved, saturated, or every branch closes (cap 6, `--max-rounds` up to 50) |
| Depth | ≤ 2 | ≤ 3 (`--max-depth`, max 6) |
| Sub-agents per wave | 10 by default, max 20 (`--sub-agents`) | 10 by default, max 20 (`--sub-agents`) |
| Time | Fitted inside the harness bash timeout | No self-imposed deadline |
| LLM calls | 2 | 2 + 1 per extra wave |
| Brave requests | ≤ `--max-queries` (default 10) | ≤ waves × `--sub-agents` |
| Typical | 45–110 s · ~$0.01–0.03 | 2–15 min · ~$0.03–0.15 |

A wave is not a bigger round: a depth-2 query exists **because** a depth-1
result raised it, and `--ledger` shows the parent of every query. That is what
separates deepening from re-searching.

`surf-search-unlimit` enforces no deadline of its own — on Claude Code give the
Bash call `timeout: 600000`, on Pi core just run it, on GH Copilot CLI run
`surf-research-skill project-config` first.

---

## Install & first run

```bash
# One-liner cross-OS install (Linux, macOS, Windows)
npm i -g surf-agent-skill

# Postinstall symlinks both skills into every supported harness, initializes
# ~/.config/surf/keys.json, and prints a hint. Then:

surf                            # your Brave key — validated live, for free
surf-research-skill ai-setup    # the OpenRouter key surf-ai plans + synthesizes with

# Any command that would touch Brave checks the key first:
surf-research-skill search "your query"
# → in a TTY with no valid key: prints the gate error, offers the wizard, resumes
# → outside a TTY: prints the gate error and exits 78
#
# The surf-search-* commands gate the same way, before the LLM plans anything.
# In v7 they degraded to a keyless tier instead; they no longer can.

# In each project where you'll use surf (REQUIRED for GH Copilot CLI):
cd path/to/your-project
surf-research-skill project-config
```

**What degrades, and what does not:**

| You have | surf-ai does |
|---|---|
| Brave key + OpenRouter key | Everything: gate → plan → wave → analyze → deepen → synthesize |
| Brave key, no OpenRouter key | Deterministic plan, real searches, a cited evidence brief, no synthesis — labelled `⚠ Degraded mode` |
| OpenRouter key, **no valid Brave key** | **Nothing. Exit 78.** There is no search backend to degrade to, and inventing one would be lying about where the answer came from. |

The LLM is optional; the search backend is not. That asymmetry is the whole
design: a research answer with no sources is not a degraded answer, it is a
fabricated one.

### Use as a Node library

```bash
npm i surf-agent-skill
```

```js
import { search, searchParallel, GateError } from 'surf-agent-skill';

// Auto-discovers keys: opts > process.env > .env > ~/.config/surf/keys.json
const r = await search('claude api', { max: 3 });
console.log(r.data.results[0].url);

// Or pass keys explicitly (great for serverless / Next.js API routes)
const r2 = await search('x', {
  braveKeys: [process.env.MY_BRAVE_1, process.env.MY_BRAVE_2],
  mode: 'slow',                      // 20 results
  domains: 'docs.rs,github.com',     // OR-grouped site: operators
  time: 'year',                      // → Brave freshness=py
});

// Batch search (single call, N queries, partial-failure tolerant, sequential)
const batch = await search(['topic A', 'topic B', 'topic C'], { max: 2 });

// Parallel fan-out, paced to your Brave plan's real rate limit
const par = await searchParallel(['angle A', 'angle B', 'angle C'], { subAgents: 6, max: 3 });

// The gate applies to the library too — it rejects rather than degrading.
try {
  await search('x', { braveKeys: [] });
} catch (e) {
  if (e instanceof GateError) console.error(e.code); // 'BraveKeyMissing'
  // e.code is one of BraveKeyMissing / BraveKeyBurned / BraveKeyCooling /
  // BraveKeyInvalid / BraveKeyUnverified — all five match /^BraveKey/.
}
```

**The whole surf-ai loop is importable too** — same engine as the CLI:

```js
import { runSurfAi } from 'surf-agent-skill/ai';

const result = await runSurfAi(
  {
    question: 'does OpenRouter enforce strict json_schema on DeepSeek?',
    task: 'adding structured LLM calls to a CLI',
    goal: 'know which request fields to send and what silently degrades',
    insights: 'I think response_format.json_schema.strict works everywhere',
  },
  { mode: 'normal' },   // or 'unlimit', plus subAgents / maxRounds / maxDepth / aiModel
);

console.log(result.answer);              // the synthesized markdown
console.log(result.ledger.sourcesList()); // [{ n, url, title, date }, …]
console.log(result.diagnostics.degraded); // [] when every stage ran on the LLM
```

`runSurfAi` reads keys from `~/.config/surf/keys.json` and picks up
`OPENROUTER_API_KEY` from the environment. It never throws for research
failures — inspect `result.diagnostics.degraded` and `result.stats.sources`.

Library works server-side (Node / Next.js API routes / Express). Not for
browser bundles — Brave and OpenRouter don't enable CORS for
browser origins.

---

## Why this exists

**Two problems, one package.**

### 1. Research orchestration doesn't belong in the agent's context

Asking a coding agent to run good research means asking it to decompose the
question, write category-diverse queries, fan them out, read the harvest,
notice what's missing, and search again — all while holding your actual task
in the same context window. It burns tokens, it's inconsistent between runs,
and every skill that tries it ends up shipping a 600-line instruction file
the model half-follows.

surf-ai makes that loop **code**. The agent writes a four-line brief and gets
a cited answer. The loop is deterministic, the concurrency is bounded, the
coverage is auditable (`--ledger`), and the cost is visible in the footer.

### 2. A research tool that degrades silently is worse than one that fails

Up to v7 this package fanned out across Tavily, Parallel and Brave, and — when
every paid key was exhausted — quietly dropped to a free Wikipedia/DuckDuckGo
tier and returned a confident, cited-looking answer at exit 0. The caller could
not tell that answer apart from a real one.

v8 removes the choice. **Brave Search is the only backend**, and there is no
tier underneath it. That is enforced structurally, not by convention: no other
search adapter exists in the codebase, so there is no code path that *could*
answer from somewhere else.

What that buys you:

- **A hard stop you can branch on.** No valid Brave key → **exit 78**
  (`EX_CONFIG`), before any LLM call, with a message naming the exact fix.
  78 is distinct from 1 (the operation ran and failed) and 2 (you typed the
  command wrong), so an orchestrating agent knows retrying is pointless.
- **Free validation, so the gate is real.** A Brave request with no `q` is
  rejected before it is billed, and a good key and a bad key are told apart by
  `error.code`. Validating costs nothing, which is what makes it affordable to
  check on every invocation (cached 7 days).
- **Multi-key that means something specific.** Add as many Brave keys as you
  like. Rotation is automatic on auth failure, burned keys auto-reset on the
  first of the month, and rate-limited keys get a persisted cooldown. But the
  real reason for a second key is throughput: **each key carries its own
  per-second rate budget**, so two keys genuinely double how many sub-agents
  can search at the same time.
- **Rate limiting that survives process boundaries.** Brave enforces a
  1-second sliding window counted on arrival. The sub-agents of
  `surf-research-agent-skill` are separate OS processes, so surf's token bucket
  lives on disk and is shared by every surf process on the machine. Asking for
  10 sub-agents on a 1 req/s plan does not fail — it queues, and surf says so.
- **Errors classified by cause, not by status code.** Brave answers an invalid
  key *and* a bad parameter with the same HTTP 422. v7 read both as "bad key"
  and burned every key in the ring the first time someone typed `--country zzz`.
  v8 branches on `error.code`, so a typo costs a usage error and a plan-gated
  feature costs nothing at all.
- **Model fallback is unchanged.** surf-ai still walks a verified DeepSeek chain
  (`v4-pro` → `v4-flash-0731` → `v4-flash` → `v3.2` → `chat-v3.1`), downgrades a
  rejected JSON schema to plain-text JSON, and parses replies wrapped in prose
  or code fences.
- **Predictable output.** `--json` returns the same normalized envelope every
  time.

### 3. "Deeper" should mean deeper, not just longer

v7's loop was flat: plan N queries, run them, ask the model for N more, run
those. Nothing recorded *why* a query existed or *what it descended from*, so
depth was indistinguishable from repetition and the only thing stopping it was a
round counter.

v8 runs a **priority frontier over a tree**. Every query is a node that knows
its parent, its depth and its kind (`breadth` / `depth` / `verify`), so the loop
can reason about a *branch*: it sees that one sub-question is saturated while
another is still thin, closes the first, and spends the next wave on the second.

- a **per-branch quota**, so one hot sub-question cannot consume a whole wave
  while three others go unresearched;
- a **verification reserve**, so falsifying a contested claim outranks widening;
- **deterministic admission** — duplicates, over-deep nodes and closed branches
  are rejected by plain code, and every rejection is *recorded* rather than
  silently dropped (a forgotten rejection gets re-proposed every round and the
  loop never converges);
- **automatic branch closure** after two waves that add no new sources.

`--ledger` prints the whole thing: the coverage table with depth and parent
columns, and the list of candidates the frontier refused, with reasons.

---

## Supported agents

> **What the installer does and doesn't do.** `npm i -g surf-agent-skill` symlinks
> both skills into every harness skill dir it knows
> (`~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`,
> `~/.pi/agent/skills/`) and creates `~/.config/surf/keys.json`. It writes
> **no** timeout config anywhere. Raising a bash timeout is a separate,
> **per-project** step — `surf-research-skill project-config`, which supports
> `copilot`, `claude` and `pi`.

### Claude Code

```bash
npm i -g surf-agent-skill
# Symlinks both skills into ~/.claude/skills/. Writes no settings.

# Per-project, to raise the 120 s default to 300 s:
cd path/to/your-project
surf-research-skill project-config
# → writes .claude/settings.local.json (gitignored by Anthropic convention):
#     { "env": { "BASH_DEFAULT_TIMEOUT_MS": "300000",
#                "BASH_MAX_TIMEOUT_MS": "600000" } }
```

The skill becomes available at `~/.claude/skills/surf-research-agent-skill/`. In a
Claude Code session, just ask: "search the web for X" — the agent invokes
`surf-search-normal` via Bash and gets back a cited answer.

Claude Code's Bash tool defaults to **120 s**, and the model may request up to
**600 s** per call (`BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` override
both). Since **v2.1.210**, hitting the timeout **moves the command to the
background** rather than killing it — but don't rely on that: for
`surf-search-unlimit`, pass `timeout: 600000` explicitly, or
`run_in_background: true` and monitor via `/tasks`.

### GitHub Copilot CLI

⚠️ **Default bash timeout is 30 s — the most fragile of the three.**

```bash
npm i -g surf-agent-skill
# Symlinks both skills into ~/.agents/skills/ — the canonical skill dir
# GH Copilot CLI reads (~/.agents/skills/surf-research-agent-skill, …/surf-plan-agent-skill).
# Nothing is written under ~/.copilot/.
```

**Per-project**, run inside the project root:

```bash
surf-research-skill project-config
# writes .github/copilot-hooks.json with { "timeoutSec": 300 }
# detects .github/ automatically; use --harness copilot --yes to force
```

Without this, any `surf-research-skill` command other than `--help`, `--version`,
`gate`, `keys list/add`, or `search --max 1` will time out. With it, you can use
the full command set up to ~5 min per call.

There is no async pattern to fall back on: `research-start` and
`research-poll` were **removed in v8** and now exit 2. For longer work, raise
the timeout with `project-config` and use `surf-search-normal` (which fits
itself inside whatever budget it is told about), or `/delegate` the whole
`surf-search-unlimit` call and let it run to completion in that session.

If surf-research-skill detects the agent will likely kill the call before it can
finish, it now aborts early with `LikelyAgentTimeout` and tells the agent
to suggest `surf-research-skill project-config` to the user — instead of dying
silently to SIGTERM.

### Pi Coding Agent

```bash
npm i -g surf-agent-skill
# Symlinks the skills into ~/.pi/agent/skills/.
```

**Pi core applies NO bash timeout at all** — its `timeout` tool parameter is
optional (and in *seconds*, not milliseconds), and no `PI_*` env var sets a
default. So long calls run unbounded. This is the best harness for
`surf-search-unlimit`:

```bash
surf-search-unlimit "<open-ended question>" --task … --goal … --sub-agents=10 --max-depth 3
```

surf can't detect Pi from the environment. For the **manual** commands that
means passing `--no-budget` (or `SURF_NO_TIMEOUT=1`) so surf doesn't self-abort
at its 30 s worst-case guess:

```bash
surf-research-skill search-parallel --queries-file q.json --sub-agents=8 --no-budget
```

`surf-search-unlimit` already runs with no self-budget, and
`surf-search-normal` budgets 110 s when it can't detect a harness (see
**Timeouts at a glance**), so neither needs the flag.

If you run the optional **`pi-bash-timeout`** extension it re-imposes a 120 s
cap; `surf-research-skill project-config` raises that to 300 s (writes
`.pi/settings.json`). For long-running work, Pi also supports subagents.

### OpenCode & Codex CLI

The installer symlinks both skills into both harnesses' canonical dirs
(`~/.agents/skills/` for OpenCode, `~/.codex/skills/` for Codex CLI) — but it
writes **no** timeout config for either, and `project-config` doesn't target
them (it supports `copilot`, `claude`, `pi`).

If OpenCode kills long calls, set the timeout yourself in
`~/.config/opencode/opencode.json`, or export
`OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` — surf **reads** that variable
to size its own budget, so telling surf the truth is often enough:

```bash
export OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=600000
```

---

## Timeouts at a glance

| Agent | Default bash | Max | After install | `surf-search-normal` | `surf-search-unlimit` |
|---|---|---|---|---|---|
| **Claude Code** | 120 s | 600 s (model-requestable) | 300 s default | ✅ fits | pass `timeout: 600000` |
| **GitHub Copilot CLI** | **30 s** | not documented | unchanged (no global config) | run `project-config` first | run `project-config` first |
| **Pi Coding Agent** | **none (core)** | unbounded | nothing to do | ✅ fits | ✅ ideal |
| **OpenCode** | varies | 600 s | 600 s default | ✅ fits | usually fits |

**How `surf-search-normal` picks its budget** (`resolveNormalBudget` in
`src/lib/ai/orchestrator.mjs`):

1. `--budget-ms N` / `SURF_AI_BUDGET_MS` — wins over everything. `0` = unlimited.
2. A *measured* harness budget (`BASH_DEFAULT_TIMEOUT_MS`,
   `PI_BASH_DEFAULT_TIMEOUT_SECONDS`, `OPENCODE_EXPERIMENTAL_…`) — used as-is.
3. Nothing detected → **110 s**, announced on stderr. The plain `search`
   command assumes 30 s in that case, which is right for one HTTP call and
   wrong for a plan + fan-out + synthesis; every mainstream harness allows more.

Whatever it picks, the run is fitted inside it: planning gets ≤20 %, searching
and synthesis split the rest 60/40, and 5 % is held back as cushion. It returns
an answer rather than being killed mid-flight.

If you see timeouts, the order of fixes:

0. **surf-ai**: pass `--budget-ms <the timeout you gave the Bash call>`. If the
   harness genuinely kills sooner than 110 s (Copilot CLI), run
   `surf-research-skill project-config` or pass `--budget-ms 25000`.
1. On a **no-limit harness (Pi core)**, the manual commands need `--no-budget`
   (or `SURF_NO_TIMEOUT=1`) so surf doesn't self-abort at its 30 s guess.
2. Reduce `--max` / `--max-depth` / `--max-queries` / `--max-rounds`.
3. Bump the per-harness timeout (see the relevant card above).
4. Set `SURF_TIMEOUT_MS=300000` (caps the HTTP request itself at 5 min) or
   `SURF_AI_TIMEOUT_MS` (caps a single LLM call, default 120 s).

---

## Commands

### surf-ai — the autonomous loop

| Command | What it does |
|---|---|
| `surf-search-normal <q>` | **One** wave, fitted inside the harness bash timeout |
| `surf-search-unlimit <q>` | Waves until the question resolves, the sources saturate, or every branch closes |
| `surf-research-skill ai <q> --mode normal\|unlimit` | The same engine as a subcommand |
| `surf-research-skill ai-setup [--key …]` | Store the OpenRouter key (free validation) |
| `surf ai-key` | Same, from the bundle CLI |

surf-ai flags:

```
--task "<what you are building/doing right now>"
--goal "<what you need out of this research>"
--insights "<what you already believe — VERIFIED, not assumed>"
--deliverable "<the exact shape of answer you want back>"
--brief-file <f.json>   {"question","task","goal","insights","deliverable"}

--sub-agents N     simultaneous searches (default 10, max 20). Also --sub-agents=N.
                   THE one simultaneity budget: it is both the wave width and the
                   worker-pool width, so the two can never multiply. Above what
                   your Brave plan serves per second it queues, and surf says so.
--concurrency N    deprecated alias for --sub-agents
--max-depth N      how far a branch may descend (normal 2, unlimit 3, max 6)
--max-rounds N     wave cap, unlimit only (default 6, hard cap 50)
--max-queries N    frontier admissions per wave (normal 10, unlimit 14, max 40).
                   Always raised to at least --sub-agents.
--max N            results per search (1-20). Overrides --search-mode.
--budget-ms N      normal only — pass the timeout you gave the Bash call. 0 = unlimited
--ai-model <slug>  override the LLM (default deepseek/deepseek-v4-pro)
--search-mode <fast|normal|slow>
--ledger           append the per-query coverage table
--out <file>       also write the answer to a file
```

Exit codes: `0` an answer (possibly degraded) · `1` nothing retrieved at all ·
`2` usage error · **`78` no valid Brave key — configuration is broken, retrying
will not help** · `143` the harness killed it.

### The manual toolbox

| Command | What it does |
|---|---|
| `gate [--json]` | **Is there a usable Brave key?** Exit `0` = yes, `78` = no. Use this, not `keys list`, to check |
| `setup` | Interactive wizard: your Brave key (required) + OpenRouter (TTY) |
| `project-config` | Write per-project bash-timeout config |
| `search <q> [q2 ...]` | Web search; multiple positional args = **batch** (sequential) |
| `search-parallel <q…>` | Fan-out, paced to your Brave plan; `--queries-file`, `--sub-agents` |
| `cache-clear` | Purge response cache |
| `cost [--reset]` | Local request ledger |
| `keys <subcmd>` | `add`, `remove`, `list`, `reset`, `clear` (`--provider brave\|openrouter`) |

**Removed in v8:** `extract`, `crawl`, `map`, `research`, `research-start`,
`research-poll`, `usage`. Brave's `/web/search` returns ranked links and
snippets, never page content, and has no crawl, site-map or async-research
endpoint — so these had no honest implementation. They now exit 2 with an
explanation rather than an "unknown command". If you need a page's text, follow
the URL yourself. (Brave *does* ship an `/llm/context` endpoint that returns
extracted page content, but it is plan-gated — see
[`references/brave-api.md`](references/brave-api.md).)

### Checking the key before you spend anything

```bash
surf-research-skill gate || echo "no usable Brave key (exit 78)"
surf-research-skill gate --json     # masked diagnostic: verdict, code, key index
```

`gate` is the only verb that both **runs without a key** and **reports the
answer in its exit code** — exit `0` a usable key exists, exit `78` it does not
and retrying will not help. Use it, not `keys list`: `keys list` also runs
without a key (it has to — a missing key is diagnosed by listing the keys), but
it is a report and **always exits 0**, so branching on it is a dead branch.

`--json` prints the verdict, the `BraveKey*` code, the key index and the
keys file. Every key value in it is masked; no key material reaches stdout.

Full reference: `SKILL.md`.

Global flags every command accepts:

```
--mode <fast|normal|slow>           Results per query: 5 / 10 / 20. Default normal.
                                    ⚠ On `surf-research-skill ai`, --mode means
                                      something else entirely: normal|unlimit.
                                      Use --search-mode there for the tier.
--max N                             Explicit result count, 1-20. Overrides --mode.
--offset N                          Page index, 0-9 (Brave caps pagination there)
--time <day|week|month|year>        → Brave freshness (pd/pw/pm/py)
--start-date / --end-date YYYY-MM-DD  freshness range; beats --time
--domains a.com,b.com               Restrict to these sites (OR-grouped site: ops)
--exclude c.com                     Exclude a site (-site:)
--country XX · --search-lang · --ui-lang · --safesearch <off|moderate|strict>
--goggles <url>                     Brave Goggles re-ranking
--result-filter <list>              web,news,discussions,faq,…
--no-cache                          Skip response cache
--no-budget                         Disable the self-budget abort — let calls run
                                      to the provider's per-request ceiling. No-limit
                                      harnesses only (Pi core). = SURF_NO_TIMEOUT=1
--json                              Normalized envelope as JSON
--raw-json                          Raw provider response (bypasses cache)
--quiet                             Silence progress logs (stderr)
```

Every flag above is **validated before the request goes out**. A typo is a usage
error (exit 2), not a silently different search — and, importantly, not a burned
key: Brave answers a bad parameter with the same HTTP 422 it uses for a bad
token, and v7 could not tell them apart.

### Search modes

`--mode` selects how many results one question is worth. Brave has no native
depth tiers, so the tier is expressed as breadth:

```bash
surf-research-skill search "X" --mode fast    # 5 results  — a quick fact check
surf-research-skill search "X" --mode normal  # 10 results — the default
surf-research-skill search "X" --mode slow    # 20 results — Brave's per-page maximum
```

With no `--mode`, you get `normal` (10). *In v7 the CLI silently injected
"advanced" here, so every search ran at the widest and most expensive tier while
`--help` promised `normal`.*

More results is the only way to get more text: Brave returns a `description`
plus up to five `extra_snippets` per result, and no page content at all. Going
past 20 means a **different query**, not a bigger one — `offset` is capped at
page 9 and the well typically runs dry before that.

```bash
# Narrow instead of widen — this is what actually deepens a search:
surf-research-skill search "hnsw index limits" --domains postgresql.org --time year
surf-research-skill search "hnsw index limits" --exclude medium.com --mode slow
```

---

## Batch your queries (manual fan-out)

> **Most of the time you want `surf-search-normal` instead.** It writes better
> queries than a hand-built list, runs them concurrently, records coverage, and
> synthesizes. Reach for the commands below when you already know the exact
> queries you want and don't want a synthesis on top.

When you need to research **multiple angles** of the same topic, batch them
in a single call. Each positional arg is an independent query:

```bash
surf-research-skill search "compare X vs Y" "alternatives to X" "X security issues"
```

- Runs sequentially (avoids rate-limit thrashing on a single key).
- Partial failures are reported inline — the command exits `0` if at least
  one query succeeded.
- Total credits and timing surface in the markdown header and `--json` envelope.
- Progress logs (see below) show `[i/N]` per query.

Among the *manual* commands, batching beats looping with N separate bash calls
— one process, one credit tally, one set of `[i/N]` progress logs. It is not a
substitute for `surf-search-normal`: if you are still deciding what the queries
should be, that decision belongs to surf-ai (the orchestrator's R1 rule forbids
agents from running their own search loop — "Você nunca pesquisa").

**Need true parallelism?** `surf-research-skill search-parallel` runs the queries
**concurrently** through a bounded worker pool (`--sub-agents`, default 10, cap
20) that is itself paced to your Brave plan's real requests-per-second, tolerant
of partial failures (one 429 backs off from `x-ratelimit-reset`; the batch never
aborts). It
accepts positional queries and/or a JSON `--queries-file`
(`[ "q", {"q":"…","id":"…","sub":"…"} ]`) and groups output by sub-question:

```bash
surf-research-skill search-parallel "angle A" "angle B" "angle C" --sub-agents=6 --json
surf-research-skill search-parallel --queries-file q.json --sub-agents=8 --no-budget --json
```

On a no-limit harness (Pi core) add `--no-budget`; on time-limited harnesses
keep `--sub-agents` modest or split the file — remember that on a slow Brave
plan a wide fan-out spends wall-clock queueing, not searching.

surf-ai uses this same bounded pool internally — it just writes the queries
itself and reads the results back into a gap analysis, which is why an agent
almost never needs to call `search-parallel` by hand.

---

## Progress logs (stderr)

Every operation emits one self-contained line per event to **stderr**, so
both humans and the calling LLM can see what's happening without parsing
the main result on stdout.

Manual commands:

```
[surf 17:58:12] ▸ search → brave (key #0)
[surf 17:58:12] ⓘ brave: paced 298ms (plan allows 1 req/s)
[surf 17:58:14] ✓ search brave 1058ms (1 credits)
[surf 17:58:14] ↻ brave 429 — backoff 654ms (attempt 1/3)
[surf 17:58:18] ⚠ brave key #0 burned (422)
[surf 17:58:18] ▸ search → brave (key #1)
[surf 17:58:20] ✓ search brave 902ms (1 credits)
[surf 17:58:20] ⏱ batch done: 3/3 ok, 0 failed (8200ms, 3 credits)
```

surf-ai (a real `surf-search-unlimit` run):

```
[surf 18:42:15] ⓘ surf-ai: using 1 OpenRouter key(s) from the environment (not persisted)
[surf 18:42:15] ▸ surf-ai [unlimit] planning · harness=pi · no time budget (unlimit)
[surf 18:42:42] ✓ plan deepseek/deepseek-v4-pro 26802ms (2550 tok, $0.00271)
[surf 18:42:42] ⓘ surf-ai plan: 2 sub-question(s), 5 seed queries · up to 10 sub-agent(s) per wave, depth ≤ 3
[surf 18:42:42] ▸ surf-ai wave 1/6: 5 sub-agent(s) · depth 0-0 · 2 open branch(es)
[surf 18:42:48] ⏱ surf-ai wave 1: 5/5 ok, 0 failed · +49 new source(s) (49 total)
[surf 18:44:03] ✓ analyze deepseek/deepseek-v4-pro 75065ms (9754 tok, $0.02349)
[surf 18:44:03] ⓘ surf-ai: closed branch 'sq1' (the analyst reported it answered)
[surf 18:44:03] ⓘ surf-ai: 3 open point(s) → 4/6 follow-up(s) admitted (4 queued, 2 rejected so far)
[surf 18:44:09] ▸ surf-ai wave 2/6: 4 sub-agent(s) · depth 1-1 · 1 open branch(es)
[surf 18:44:50] ✓ synthesize deepseek/deepseek-v4-pro 47436ms (14005 tok, $0.01094)
[surf 18:44:50] ⏱ surf-ai done: 2 wave(s), 9 queries, 71 source(s), 154970ms
```

The format is stable for grep/parse. Use `--quiet` or `SURF_QUIET=1` to
silence (CI, piping, tests). Stdout stays clean either way.

Timestamps are in **UTC**.

---

## Multi-key, rate limiting & the gate

`~/.config/surf/keys.json` holds **two** provider sections: `brave` (the search
backend) and `openrouter` (the LLM). They share the same rotation machinery;
`openrouter` is deliberately absent from the search capability chain, so a
search can never be routed to it.

**Why add a second Brave key.** Not redundancy — *throughput*. Brave enforces
its rate limit per key, so two keys carry two per-second budgets and genuinely
double how many sub-agents can search at once.

```
keys.json (per provider — brave | openrouter):
  keys:       [key0, key1, key2]
  current:    1                       ← starts here next call
  burned:     [{ index: 0, reason: "422", at: "2026-05-15..." }]
                                      ← auto-reset on the 1st of next month
  cooldowns:  [{ index: 2, until: "2026-05-15T12:34:56Z" }]
                                      ← after a 429; persists across runs
  validated:  [{ index: 1, at: "2026-05-15...", ok: true }]
                                      ← the free gate verdict, TTL 7 days

search call flow:
  ┌─ load state, auto-reset burned ───────────────────┐
  │                                                   │
  ├─▶ cache hit? ─▶ return it (no key needed, no cost)│
  │                                                   │
  ├─▶ THE GATE: a usable, validated Brave key?        │
  │     no ─▶ exit 78. Nothing below runs.            │
  │                                                   │
  └─▶ for key in usable_keys(brave):                  │
        take a slot from the cross-process rate bucket│
        try call                                      │
          200 ─▶ learn the plan's req/s, return       │
          422 SUBSCRIPTION_TOKEN_INVALID ─▶ burn, next│
          422 VALIDATION ─▶ raise (your parameter)    │
          400 OPTION_NOT_IN_PLAN ─▶ raise (your plan) │
          429 ─▶ backoff from x-ratelimit-reset, retry│
          5xx x3 ─▶ cooldown the key, next            │
      raise AllKeysExhausted ──────────────────────────┘

There is no rung below that. A failed search is never dropped — it stays in the
ledger with its reason, and if every search failed the run says so instead of
synthesizing an answer out of nothing.

LLM call flow (src/lib/ai/openrouter.mjs):
  for model in [v4-pro, v4-flash-0731, v4-flash, v3.2, chat-v3.1]:
    for key in usable_openrouter_keys:          ← recomputed per model
      200 + parseable JSON ─▶ remember key, return
      401/402/403          ─▶ burn key, next key
      429                  ─▶ honor Retry-After, retry, then cool the key
      404 "no endpoints for requested parameters"
      400 "response_format …"
      503 (routing)        ─▶ DOWNGRADE the schema, retry same model
      404 unknown model    ─▶ abandon model, next model
      unparseable reply    ─▶ downgrade to plain-JSON, then loose-parse
  every rung failed ─▶ AiUnavailable ─▶ deterministic fallback, answer still returned
```

`--provider` still exists, but the only accepted value is `brave`; anything else
is a usage error naming that fact.

---

## Onboarding

`surf-research-agent-skill` requires a **Brave Search key**. There is no free
tier and no keyless mode — get one at
[api-dashboard.search.brave.com](https://api-dashboard.search.brave.com).

**Both validations are free.** Brave rejects a `q`-less request before billing
it, and OpenRouter exposes free key introspection. Nothing below costs a credit.

```bash
# 1. Wizard (recommended in a TTY) — prompts Brave, then OpenRouter
surf-research-skill setup
surf                                   # same thing, with a menu

# 2. surf-ai's LLM key on its own
surf-research-skill ai-setup
surf-research-skill ai-setup --key sk-or-v1-...     # non-interactive
surf ai-key

# 3. Direct — many keys per provider in one call (each live-validated)
surf-research-skill keys add --provider brave BSA-AAA BSA-BBB BSA-CCC
surf-research-skill keys add --provider openrouter sk-or-v1-AAA sk-or-v1-BBB
cat brave-keys.txt | surf-research-skill keys add --provider brave --stdin

# 4. Any command without a valid key
surf-research-skill search "test"
# → in a TTY: the gate error, then the wizard, then your command resumes
# → otherwise: the gate error and exit 78

# 5. Environment / library mode
BRAVE_API_KEY=BSA-... node -e "import('surf-agent-skill').then(m => m.search('x'))"
export BRAVE_API_KEYS=BSA-a,BSA-b        # rotated, and each carries its own rate budget
export OPENROUTER_API_KEY=sk-or-v1-...   # picked up by surf-ai, never persisted
export OPENROUTER_API_KEYS=sk-a,sk-b     # …and rotated like any other key list
```

Inspect what was stored (keys are masked):

```bash
surf-research-skill keys list
# **Surf keys** (config: ~/.config/surf/keys.json)
# last_ok_provider: `brave`
# ## brave (2 keys)
# - [0] BSA-A…ab12  *(current, validated 2026-08-29)*
# - [1] BSA-B…cd34            <- a key the gate has proved bad shows *(INVALID)*
# ## openrouter (1 key)
# - [0] sk-or…9f2c  *(current)*

surf doctor
# ## surf-ai
#   ✓ ready — 1 stored key(s) + 1 from OPENROUTER_API_KEY(S)
#     default model: deepseek/deepseek-v4-pro
```

---

## Troubleshooting

### surf-ai

**`> ⚠ Degraded mode — no LLM synthesis`** (exit 0)
→ No usable OpenRouter key, or every model/key combination failed. The
searches ran and the output is a real cited evidence brief — it just wasn't
analyzed. Run `surf-research-skill ai-setup`, or check
`surf-research-skill keys list` for a burned `openrouter` key, then re-run.
**This is a success, not an error.** Don't retry it as if it failed.

**`> ⚠ Degraded stage(s): plan (…)`** (exit 0)
→ The planner was unavailable so a deterministic query plan was used. Results
are usable but less targeted. Re-run if precision matters.

**`❌ No sources retrieved`** (exit 1)
→ Every Brave search failed. The report lists what was tried and why. Usually
the harness killed the calls (raise the timeout, see above) or the key ran out
of monthly quota. Note this is *not* the missing-key case: that exits **78**
before any search runs.

**`❌ Error [BraveKeyMissing|BraveKeyBurned|BraveKeyCooling|BraveKeyInvalid|BraveKeyUnverified]`** (exit **78**)
→ The gate. There is no usable Brave key, so nothing ran. The message names the
exact fix. 78 is `EX_CONFIG` — distinct from 1 and 2 precisely so an
orchestrating agent knows that retrying is pointless. All five codes start with
`BraveKey`, so `/^BraveKey/` still matches the whole family.
- `BraveKeyMissing` → `surf-research-skill keys add --provider brave <key>`
- `BraveKeyBurned` → `surf-research-skill keys reset --provider brave`
  (burns also clear on the 1st of the month)
- `BraveKeyCooling` → wait out the rate-limit cooldown, or add a second key
- `BraveKeyInvalid` → Brave answered and **rejected the token**. Do not delete
  the key on this alone: **the verdict is cached for up to 7 days**, so the
  message you are reading may be a week old. Run
  `surf-research-skill keys reset --provider brave` first — it clears the cached
  verdict and the cooldowns, and the next command re-tests the key live, for
  free. Only if it is rejected *again* after that is the key really dead:
  `surf-research-skill keys remove --provider brave <index>`, then add a working
  one.
- `BraveKeyUnverified` → **nothing was decided about your key.** The probe never
  got an answer — a dropped connection, DNS, a timeout, a 5xx from Brave, or a
  status no one can attribute (captive portal, corporate proxy). Those are facts
  about the *path* to Brave, not about the key, so **no verdict was cached** and
  the next command re-probes for free. Fix this machine's network or wait out
  the Brave outage, then re-run the same command; `surf doctor` re-checks the
  gate without spending a search. **Never remove a key on account of this
  message** — it was never judged. (This verdict exists because a network blip
  used to be recorded as `BraveKeyInvalid` and cached for 7 days, which turned a
  three-second wifi drop into a week of exit 78 that survived a reboot. Only
  Brave rejecting the token — `kind === 'auth'` — may convict a key now; see
  `provesKeyBad` in `src/lib/preflight.mjs`.)

**`--sub-agents 10` but the wave takes ten seconds**
→ That is the rate limiter, not a hang. Your Brave plan allows fewer requests
per second than you asked for, so surf queues them rather than collecting 429s.
It warns when this happens. Adding a second Brave key is the only real fix —
each key carries its own per-second budget.

**Answer looks generic / doesn't address my situation**
→ You didn't pass the brief. `--task`, `--goal` and `--insights` are what turn
"tell me about X" into an answer aimed at your actual decision.

**`surf-search-unlimit` was killed mid-run**
→ It enforces no deadline of its own; the *harness* did. Give the Bash call an
explicit long timeout (Claude Code: `timeout: 600000`), run
`surf-research-skill project-config`, or use `surf-search-normal`.

**Cost is higher than expected**
→ The footer prints the real spend. Reduce `--max-rounds`, `--sub-agents`, or
pass `--ai-model deepseek/deepseek-v4-flash-0731` (same 1M context, roughly a
third of the price).

### Search / keys

**`❌ Error: 'crawl' was removed in v8.0.0…`** (exit 2)
→ `extract`, `crawl`, `map`, `research`, `research-start`, `research-poll` and
`usage` are gone; Brave has no equivalent. Use `search` and follow the URLs.

**`❌ Error [UnknownProvider]: --provider 'tavily' does not exist in surf v8`**
→ Brave is the only provider. Drop the flag.

**`❌ Error [AllKeysExhausted]: ...`**
→ Every Brave key failed. Check `surf-research-skill keys list`
— if everything is `burned`, you've either rotated keys mid-billing-cycle
or the providers are down. Run `surf-research-skill keys reset` to retry.

**Command timed out in GH Copilot CLI**
→ Run `surf-research-skill project-config` inside the project root. See the
Copilot CLI card above.

**`❌ Error [LikelyAgentTimeout]: ...`**
→ surf-research-skill detected the harness will kill the call before it finishes
(typical on Copilot CLI without per-project config). Run `surf-research-skill
project-config` in the project, then retry. Don't retry the same call
without fixing the timeout first.

**`❌ Error [KilledBySignal]: surf-research-skill received SIGTERM/SIGINT`**
→ The harness killed us mid-flight. Same fix as `LikelyAgentTimeout`. The
SIGTERM handler exists as a fallback — the self-budget check should fire
first when env vars are set.

**`❌ Error: EXPENSIVE_BLOCKED ...`**
→ Pass `--confirm-expensive` after confirming the cost with the user. Or
export `SURF_ALLOW_EXPENSIVE=1` for the session.

**`❌ Error [BraveKeyUnverified]: ...`** (exit **78**)
→ The gate could not reach Brave, so it refused to guess. Nothing was written to
`keys.json`. Check the network and re-run — see the surf-ai section above.

---

## Repository layout (v8.0.1)

```text
.
├── package.json                       ← name: surf-agent-skill (npm), version 8.0.1, 5 bins
├── README.md           ← you're here
├── CHANGELOG.md
├── LICENSE
├── logo.png
├── SKILL.md                           ← surf-research-agent-skill / surf-ai (root of pkg)
├── bin/
│   ├── surf.mjs                       ← interactive setup + key validation
│   ├── surf-search-normal.mjs         ← surf-ai, ONE wave (fits the bash timeout)
│   ├── surf-search-unlimit.mjs        ← surf-ai, waves until resolved
│   ├── surf-research-skill.mjs        ← Brave web search CLI + `ai` subcommands
│   └── surf-plan-skill.mjs            ← planning workflow CLI
├── references/                        ← read on demand by the research orchestrator
│   ├── burst-templates.md             ← the 8 sub-agent prompt templates (T1–T8)
│   ├── surf-ai-cli.md                 ← CLI reference for writing delegation prompts
│   ├── failure-modes.md               ← the 10 degradation cases
│   ├── COSTS.md                       ← what a search costs, and the rate limit that really binds
│   ├── brave-api.md                   ← what Brave returns, what it doesn't, and every gotcha
│   └── plan-workflow.md               ← deeper docs on the planning workflow (Normal + Deep ambiguity-sweep mode)
├── skills/
│   └── surf-plan-agent-skill/SKILL.md       ← planning (auto-routes to an ambiguity-sweep mode)
├── test/
│   ├── smoke.mjs                      ← offline suite: stubs fetch, temp HOME
│   ├── brave.mjs                      ← adapter, flags, frontier, key gate — regression tests for every v7 defect
│   └── adversarial/                   ← the release gate (`npm run test:adversarial`)
│       ├── brave-limits.mjs           ← Brave's caps: count 1-20, offset 0-9, 422 vs 400
│       ├── flags-cli.mjs              ← flag parsing: the question must survive every typo
│       ├── gate-state.mjs             ← keys.json + the gate: what may and may not be cached
│       ├── lib-install.mjs            ← library entry points and the cross-OS symlink install
│       └── loop-frontier.mjs          ← the deepening tree: priority, depth, branch closure
├── src/
│   ├── index.mjs                      ← library entry (search / searchParallel)
│   ├── env.mjs                        ← key discovery (opts > env > .env > config)
│   ├── plan/                          ← plan-file, plans-dir, slug (planning lib)
│   ├── validators/                    ← per-provider key validators (live API)
│   ├── lib/
│   │   ├── ai/                        ← surf-ai — the whole research loop
│   │   │   ├── orchestrator.mjs       ← plan → wave → analyze → deepen → synthesize
│   │   │   ├── frontier.mjs           ← the deepening tree: priority, depth, branch closure
│   │   │   ├── openrouter.mjs         ← LLM client: model chain, key rotation,
│   │   │   │                            schema downgrade, loose JSON parsing
│   │   │   ├── prompts.mjs            ← the 3 stage prompts + strict JSON schemas
│   │   │   ├── ledger.mjs             ← coverage rows, source dedupe, digest budget
│   │   │   ├── heuristics.mjs         ← deterministic LLM-free fallbacks
│   │   │   ├── render.mjs             ← markdown / JSON output
│   │   │   ├── cli.mjs                ← shared command impl for all 3 entry points
│   │   │   └── setup.mjs              ← `ai-setup` OpenRouter key wizard
│   │   ├── state.mjs                  ← ~/.config/surf/keys.json I/O (brave + openrouter)
│   │   ├── preflight.mjs              ← THE GATE: valid Brave key, or exit 78
│   │   ├── ratelimit.mjs              ← cross-process token bucket, learned from Brave's headers
│   │   ├── html.mjs                   ← strip Brave's <strong> markup + entities
│   │   ├── cache.mjs                  ← TTL response cache
│   │   ├── audit.mjs                  ← audit + usage JSONL
│   │   ├── flags.mjs, cost.mjs, format.mjs
│   │   ├── dispatch.mjs               ← key rotation, retries, the gate, self-budget
│   │   ├── pool.mjs                   ← bounded-concurrency worker pool
│   │   ├── keys-cmd.mjs               ← surf-research-skill keys add/remove/...
│   │   ├── setup.mjs                  ← interactive onboarding (with validation)
│   │   ├── project-config.mjs         ← surf-research-skill project-config
│   │   ├── progress.mjs               ← stderr progress events
│   │   ├── check-surf-skill.mjs       ← detect companion CLI in PATH
│   │   ├── harness-install.mjs        ← cross-OS symlink install for 2 skills
│   │   ├── api/                       ← library search / searchParallel
│   │   └── providers/
│   │       ├── index.mjs              ← capability map: search → [brave]. That's it.
│   │       └── brave.mjs              ← the only search adapter
│   └── install/
│       ├── postinstall.mjs            ← cross-OS symlinks + skeleton keys.json
│       └── preuninstall.mjs           ← cleanup our symlinks
```

---

## Security

- This repository contains **no real API keys**. The installer only uses
  placeholders.
- **Keys are only ever persisted to `~/.config/surf/keys.json`** (chmod 600).
  Nothing else on disk ever holds one.
- **CLI mode** reads the Brave key from that file and from nowhere else — not
  from the environment, not from `.env`. The
  **OpenRouter** key is the one exception: `OPENROUTER_API_KEY` /
  `OPENROUTER_API_KEYS` are also accepted so surf-ai works on machines that
  already export one. Env-sourced keys are used **in memory only** and are
  stripped back out before any write to `keys.json` (`snapshotForPersist`,
  `src/lib/ai/openrouter.mjs`).
- **Library mode is different by design.** `discoverKeys()` (`src/env.mjs`),
  which every `import { search, … } from 'surf-agent-skill'` call goes through,
  resolves keys for *all* providers in this order: explicit options →
  `process.env` (`BRAVE_API_KEY(S)`, `OPENROUTER_*`)
  → a `.env` in the current working directory → `keys.json` as a last resort.
  That is what makes it usable from serverless and CI. Pass
  `skipDotenv: true` / `skipConfigFile: true` to switch those levels off.
- The audit log records only `provider` name and key **index**, never the
  key itself. `surf-research-skill keys list` masks every key (`BSA-A…ab12` — first 5
  characters, then the last 4).
- The skill never executes content returned from the web — it just prints it.
- **Prompt injection.** surf-ai feeds retrieved page text to an LLM, so
  fetched content is an input to a model, not just to your terminal. Every
  surf-ai prompt carries an explicit rule that search results are untrusted
  data and that instructions found inside them are content to report on, never
  to follow (`src/lib/ai/prompts.mjs`). That is a mitigation, not a guarantee —
  treat a synthesized answer the way you'd treat any web-sourced claim, and
  never let an agent act on one without review.
- **Your brief goes to OpenRouter.** `--task`, `--goal` and `--insights` are
  sent to the model as prompt text. Don't put secrets, customer data, or
  proprietary source in them.
- Review any skill before installing. Skills can instruct agents to run
  commands.

---

## License

MIT.
