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
  <strong>Autonomous web research for AI coding agents.</strong><br/>
  You state your situation; the CLI runs the whole loop — an LLM plans the queries, they fan out concurrently across <strong>Tavily</strong>, <strong>Parallel AI</strong> and <strong>Brave</strong>, the LLM analyzes what is still open, searches again, and writes the cited answer. Key rotation, provider fallback and model failover all live inside the CLI. Ships a separate free, keyless search skill (<strong>surf-free-agent-skill</strong>: Wikipedia + DuckDuckGo, no API key).
</p>

---

## surf-ai — the agent stops orchestrating research

Before v5.4, this package handed the agent a toolbox and a 600-line SKILL.md
explaining how to decompose a question, write a query array, fan it out, read
the harvest, and decide what was missing. **That loop now runs inside the
CLI.** The agent's job is down to two things: describe its situation, and pick
one of two modes.

```
  agent: brief + mode
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ surf-ai                                                          │
│                                                                  │
│  1. PLAN        DeepSeek V4 Pro (OpenRouter) → sub-questions     │
│                 + a category-diverse query array                 │
│  2. SEARCH      ALL queries at once · bounded worker pool ·      │
│                 tavily → parallel → brave → keyless ·            │
│                 multi-key rotation · per-key cooldowns           │
│  3. ANALYZE     DeepSeek reads the harvest → what is still       │
│     (unlimit)   open + the queries that would close it           │
│  4. LOOP        open points become round N+1                     │
│     (unlimit)                                                    │
│  5. SYNTHESIZE  the answer, in the shape the agent asked for,    │
│                 cited against a numbered source index            │
│                                                                  │
│  normal  runs 1 → 2 → 5        (2 LLM calls, exactly one round)  │
│  unlimit runs 1 → 2 → 3 → 4 → … → 5                              │
└──────────────────────────────────────────────────────────────────┘
    ↓
  finished, cited answer
```

```bash
surf-search-normal  "<question>" --task … --goal … --insights …   # 1 round, fits the bash timeout
surf-search-unlimit "<question>" --max-rounds 6                    # as many rounds as needed
```

Everything that can go wrong is absorbed in there — 429s, burned keys, an
out-of-credit key, a model that 404s, a provider with no eligible endpoint, a
failed search, a reply that isn't valid JSON. **The CLI degrades and labels the
degradation; it never hands the agent an error to babysit.** No OpenRouter key
at all? It still searches and returns a cited evidence brief.

```
surf-search-normal  ┐                ┌─▶ Tavily    search · extract · crawl · map
surf-search-unlimit ┼─▶ surf-ai ─────┼─▶ Parallel  search · extract · async research
surf-research-skill ┘        │       ├─▶ Brave     search (own index)
    ai --mode …              │       └─▶ keyless   Wikipedia + DuckDuckGo (last resort)
                             │
                             └─▶ OpenRouter ─▶ DeepSeek V4 Pro
                                               plan · analyze · synthesize

free search   ──▶ surf-free-agent-skill ──▶ Wikipedia + DuckDuckGo (keyless, no API key)

plan / design ──▶ surf-plan-agent-skill ──▶ Normal (research-grounded)
                          │         └ Deep  (+ ambiguity sweep, auto on
                          │                   vague/high-stakes work)
                          └─▶ calls surf-ai for its own research (cited)
```

| | |
|---|---|
| **Status** | v5.4.0 (npm) |
| **Install** | `npm i -g surf-agent-skill` (Linux · macOS · Windows) |
| **Skills shipped** | `surf-research-agent-skill` (surf-ai) · `surf-plan-agent-skill` · `surf-free-agent-skill` |
| **Bins shipped** | `surf`, `surf-search-normal`, `surf-search-unlimit`, `surf-research-skill`, `surf-plan-skill`, `surf-free-skill` |
| **Runtime** | Node ≥ 18. Zero npm deps. |
| **Storage** | `~/.config/surf/keys.json` (chmod 600) — the only place a key is ever written. CLI reads search keys from there only; `OPENROUTER_API_KEY` is also accepted from env, in memory. Library mode reads env/`.env` too ([Security](#security)). |
| **Supported agents** | Claude Code · GitHub Copilot CLI · Pi Coding Agent · OpenCode · Codex CLI |
| **Spec** | [Anthropic Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) |

## Quickstart (60 seconds)

```bash
npm i -g surf-agent-skill          # installs 3 skills + 6 bins (cross-OS)
surf                         # interactive: add keys with LIVE validation
                             #   ✓ valid (tavily, HTTP 200, 1.2s, 1 credit)
                             #   ✗ invalid (auth, HTTP 401) — NOT saved
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
| Rounds | Exactly 1 | Until resolved (cap 6, `--max-rounds` up to 50) |
| Time | Fitted inside the harness bash timeout | No self-imposed deadline |
| LLM calls | 2 | 2 + 1 per extra round |
| Typical | 45–110 s · ~$0.01–0.03 | 2–15 min · ~$0.03–0.15 |

`surf-search-unlimit` enforces no deadline of its own — on Claude Code give the
Bash call `timeout: 600000`, on Pi core just run it, on GH Copilot CLI run
`surf-research-skill project-config` first.

---

## Install & first run

```bash
# One-liner cross-OS install (Linux, macOS, Windows)
npm i -g surf-agent-skill

# Postinstall symlinks all 3 skills into every supported harness, initializes
# ~/.config/surf/keys.json, and prints a hint. Then:

surf                            # search keys (tavily / parallel / brave), live-validated
surf-research-skill ai-setup    # the OpenRouter key surf-ai plans + synthesizes with

# A toolbox command with no search keys, in a TTY, auto-launches the wizard:
surf-research-skill search "your query"
# → "No keys configured. Launching setup wizard…"
# → prompts Tavily #1, #2, … Parallel … Brave … OpenRouter …
# → resumes your command
#
# surf-search-normal / surf-search-unlimit / `ai` never do this — they degrade
# to the keyless tier instead of hijacking your run. Run `surf` once first.

# In each project where you'll use surf (REQUIRED for GH Copilot CLI):
cd path/to/your-project
surf-research-skill project-config
```

**Degrade path, so nothing is a hard blocker:**

| You have | surf-ai does |
|---|---|
| Search keys + OpenRouter key | Everything: plan → fan-out → analyze → synthesize |
| Search keys, no OpenRouter key | Deterministic plan, real searches, a cited evidence brief, no synthesis — labelled `⚠ Degraded mode` |
| OpenRouter key, no search keys | Falls back to the keyless tier (Wikipedia + DuckDuckGo) and still synthesizes |
| Neither | `surf-free-skill "query"` — keyless, zero setup |

### Use as a Node library

```bash
npm i surf-agent-skill
```

```js
import { search, searchParallel, extract, research } from 'surf-agent-skill';

// Auto-discovers keys: opts > process.env > .env > ~/.config/surf/keys.json
const r = await search('claude api', { max: 3 });
console.log(r.data.results[0].url);

// Or pass keys explicitly (great for serverless / Next.js API routes)
const r2 = await search('x', {
  tavilyKeys: [process.env.MY_TAVILY_1, process.env.MY_TAVILY_2],
  depth: 'advanced',
});

// Batch search (single call, N queries, partial-failure tolerant, sequential)
const batch = await search(['topic A', 'topic B', 'topic C'], { max: 2 });

// Parallel search (concurrent fan-out, bounded worker pool)
const par = await searchParallel(['angle A', 'angle B', 'angle C'], { concurrency: 6, max: 3 });

// Deep research (Parallel's Task API)
const job = await research('compare X vs Y', { model: 'mini' });
console.log(job.data.content);
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
  { mode: 'normal' },   // or 'unlimit', plus concurrency / maxRounds / maxQueries / aiModel
);

console.log(result.answer);              // the synthesized markdown
console.log(result.ledger.sourcesList()); // [{ n, url, title, date }, …]
console.log(result.diagnostics.degraded); // [] when every stage ran on the LLM
```

`runSurfAi` reads keys from `~/.config/surf/keys.json` and picks up
`OPENROUTER_API_KEY` from the environment. It never throws for research
failures — inspect `result.diagnostics.degraded` and `result.stats.sources`.

Library works server-side (Node / Next.js API routes / Express). Not for
browser bundles — Tavily, Parallel and OpenRouter don't enable CORS for
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

### 2. One key, one provider, one outage away from a broken loop

Most agent search skills are **1-to-1** with a provider. When a key dies or a
provider has an outage, the loop breaks. `surf-research-agent-skill` is a connector:

- **Multi-key per provider.** Add as many keys as you want; rotation is
  automatic on `401`/`403`/`402` (auth, insufficient credits) or persistent
  `5xx`. Burned keys auto-reset on the first day of the next calendar
  month (assuming monthly billing). Rate-limited keys get a short cooldown
  that persists across runs instead of being hammered again.
- **Provider fallback.** If all Tavily keys are burned, `search`/`extract`
  fail over to Parallel — transparently. `crawl` and `map` stay on Tavily
  (Parallel doesn't have them). `research` defaults to Parallel first
  because its Task API is the strongest deep-research surface. surf-ai adds
  one more rung: when every keyed provider is exhausted it drops to the free
  keyless tier rather than returning nothing.
- **Model fallback too.** The same idea applied to the LLM: surf-ai walks a
  verified DeepSeek chain (`v4-pro` → `v4-flash-0731` → `v4-flash` → `v3.2`
  → `chat-v3.1`), downgrades a rejected JSON schema to plain-text JSON, and
  parses replies that arrive wrapped in prose or code fences.
- **Hot-path memory.** The last successful provider/key is remembered in
  `~/.config/surf/keys.json`. The next call starts there — no cold-start
  cost.
- **Predictable output.** `--json` returns the same normalized envelope
  no matter which provider answered.

---

## Supported agents

> **What the installer does and doesn't do.** `npm i -g surf-agent-skill` symlinks
> the three skills into every harness skill dir it knows
> (`~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`,
> `~/.pi/agent/skills/`) and creates `~/.config/surf/keys.json`. It writes
> **no** timeout config anywhere. Raising a bash timeout is a separate,
> **per-project** step — `surf-research-skill project-config`, which supports
> `copilot`, `claude` and `pi`.

### Claude Code

```bash
npm i -g surf-agent-skill
# Symlinks the 3 skills into ~/.claude/skills/. Writes no settings.

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
# Symlinks the 3 skills into ~/.agents/skills/ — the canonical skill dir
# GH Copilot CLI reads (~/.agents/skills/surf-research-agent-skill, …/surf-plan-agent-skill,
# …/surf-free-agent-skill). Nothing is written under ~/.copilot/.
```

**Per-project**, run inside the project root:

```bash
surf-research-skill project-config
# writes .github/copilot-hooks.json with { "timeoutSec": 300 }
# detects .github/ automatically; use --harness copilot --yes to force
```

Without this, any `surf-research-skill` command other than `--help`, `--version`,
`keys list/add`, or `search --max 1` will time out. With it, you can use
the full command set up to ~5 min per call.

For longer operations, use Copilot CLI's async pattern: `/delegate` the
`surf-research-skill research-start ...` call, then poll with `surf-research-skill
research-poll <id>` from a regular session.

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
surf-search-unlimit "<open-ended question>" --task … --goal … --max-rounds 6
```

surf can't detect Pi from the environment. For the **manual** commands that
means passing `--no-budget` (or `SURF_NO_TIMEOUT=1`) so surf doesn't self-abort
at its 30 s worst-case guess:

```bash
surf-research-skill search-parallel --queries-file q.json --concurrency 8 --no-budget
```

`surf-search-unlimit` already runs with no self-budget, and
`surf-search-normal` budgets 110 s when it can't detect a harness (see
**Timeouts at a glance**), so neither needs the flag.

If you run the optional **`pi-bash-timeout`** extension it re-imposes a 120 s
cap; `surf-research-skill project-config` raises that to 300 s (writes
`.pi/settings.json`). For long-running work, Pi also supports subagents.

### OpenCode & Codex CLI

The installer symlinks all three skills into both harnesses' canonical dirs
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
2. Use `surf-research-skill research-start` + `research-poll` instead of sync
   `research`.
3. Reduce `--limit` / `--max` / `--max-depth` / `--max-queries`.
4. Bump the per-harness timeout (see the relevant card above).
5. Set `SURF_TIMEOUT_MS=300000` (caps the HTTP request itself at 5 min) or
   `SURF_AI_TIMEOUT_MS` (caps a single LLM call, default 120 s).

---

## Commands

### surf-ai — the autonomous loop

| Command | What it does |
|---|---|
| `surf-search-normal <q>` | **One** research round, fitted inside the harness bash timeout |
| `surf-search-unlimit <q>` | Rounds until the analyst reports the question resolved |
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

--max-rounds N     unlimit only (default 6, hard cap 50)
--max-queries N    per round (normal 6, unlimit 10, cap 24)
--concurrency N    parallel searches (normal 6, unlimit 8, cap 16)
--max N            results per search (normal 5, unlimit 8, cap 20)
--budget-ms N      normal only — pass the timeout you gave the Bash call. 0 = unlimited
--ai-model <slug>  override the LLM (default deepseek/deepseek-v4-pro)
--search-mode <fast|normal|slow>
--ledger           append the per-query coverage table
--out <file>       also write the answer to a file
```

Exit codes: `0` an answer (possibly degraded) · `1` nothing retrieved at all ·
`2` usage error · `143` the harness killed it.

### The manual toolbox

| Command | What it does | Provider(s) |
|---|---|---|
| `setup` | Interactive wizard to add keys (TTY) — all 4 providers | n/a |
| `project-config` | Write per-project bash-timeout config | n/a |
| `search <q> [q2 ...]` | Web search; multiple positional args = **batch** (sequential) | tavily, parallel, **brave** |
| `search-parallel <q…>` | **Parallel** fan-out (bounded pool); `--queries-file`, `--concurrency` | tavily, parallel, brave |
| `extract <url> ...` | Pull markdown from URLs (`--urls-file` accepted) | tavily, parallel |
| `crawl <url>` | Recursive site crawl | tavily |
| `map <url>` | Sitemap discovery | tavily |
| `research <topic>` | Sync deep research (50 s budget) | parallel, tavily |
| `research-start <topic>` | Start async research | parallel, tavily |
| `research-poll <id>` | Poll an async research job | (sticky to provider) |
| `usage --provider <name>` | Provider's usage endpoint | per provider |
| `cache-clear` | Purge response cache | n/a |
| `cost [--reset]` | Local credit ledger (per-provider) | n/a |
| `keys <subcmd>` | `add`, `remove`, `list`, `reset`, `clear` (`--provider tavily\|parallel\|brave\|openrouter`) | n/a |

Full reference: `SKILL.md`.

Global flags every command accepts:

```
--provider <tavily|parallel|brave>  Force provider (disables fallback).
                                      Not accepted by surf-ai — fallback is the point.
--mode <fast|normal|slow>           Search tier. Per-provider mapping:
                                      fast   = Tavily depth=fast / Brave count=5
                                      normal = default
                                      slow   = Tavily depth=advanced / Brave count=20
                                      (Parallel ignores — single mode.)
                                    ⚠ On `surf-research-skill ai`, --mode means
                                      something else entirely: normal|unlimit.
                                      Use --search-mode there for the tier.
--no-fallback                       Keep default provider, no cross-provider fallback
--no-cache                          Skip response cache
--no-budget                         Disable the self-budget abort — let calls run
                                      to the provider's per-request ceiling. No-limit
                                      harnesses only (Pi core). = SURF_NO_TIMEOUT=1
--json                              Normalized envelope as JSON
--raw-json                          Raw provider response (bypasses cache)
--confirm-expensive                 Allow operations estimated > 10 credits
--quiet                             Silence progress logs (stderr)
```

### Search modes

```bash
surf-research-skill search "X" --mode fast    # 5 results / 1 credit Tavily / minimal latency
surf-research-skill search "X" --mode normal  # 10 results / default everywhere
surf-research-skill search "X" --mode slow    # 20 results / Tavily advanced / deeper signal
```

Want to force a specific provider for a given mode?

```bash
surf-research-skill search "X" --provider brave --mode slow    # 20 brave results, no fallback
surf-research-skill search "X" --provider tavily --mode fast   # Tavily fast tier
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
should be, that decision belongs to surf-ai (`SKILL.md` rule 2 tells agents
never to hand-roll the loop).

**Need true parallelism?** `surf-research-skill search-parallel` runs the queries
**concurrently** through a bounded worker pool (default 6, cap 16), tolerant of
partial failures (one 429 rotates keys/backs off; the batch never aborts). It
accepts positional queries and/or a JSON `--queries-file`
(`[ "q", {"q":"…","id":"…","sub":"…"} ]`) and groups output by sub-question:

```bash
surf-research-skill search-parallel "angle A" "angle B" "angle C" --concurrency 6 --json
surf-research-skill search-parallel --queries-file q.json --concurrency 8 --no-budget --json
```

On a no-limit harness (Pi core) add `--no-budget`; on time-limited harnesses
keep `--concurrency` modest or split the file.

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
[surf 17:58:12] ▸ search → tavily (key #0)
[surf 17:58:14] ✓ search tavily 1234ms (2 credits)
[surf 17:58:14] ↻ tavily 429 — backoff 1500ms (attempt 1/3)
[surf 17:58:18] ⚠ tavily key #0 burned (401)
[surf 17:58:18] ▸ search → parallel (key #0)
[surf 17:58:20] ✓ search parallel 2102ms (2 credits)
[surf 17:58:20] ⏱ batch done: 3/3 ok, 0 failed (8200ms, 6 credits)
```

surf-ai (a real `surf-search-unlimit` run):

```
[surf 18:42:15] ⓘ surf-ai: using 1 OpenRouter key(s) from the environment (not persisted)
[surf 18:42:15] ▸ surf-ai [unlimit] planning · harness=pi · no time budget (unlimit)
[surf 18:42:42] ✓ plan deepseek/deepseek-v4-pro 26802ms (2550 tok, $0.00271)
[surf 18:42:42] ⓘ surf-ai plan: 2 sub-question(s), 5 queries
[surf 18:42:42] ▸ surf-ai round 1/3: 5 searches · concurrency 8
[surf 18:42:48] ⏱ surf-ai round 1: 5/5 ok, 0 failed · 49 unique source(s)
[surf 18:44:03] ✓ analyze deepseek/deepseek-v4-pro 75065ms (9754 tok, $0.02349)
[surf 18:44:03] ⓘ surf-ai: resolved after round 1 (confidence: high)
[surf 18:44:50] ✓ synthesize deepseek/deepseek-v4-pro 47436ms (14005 tok, $0.01094)
[surf 18:44:50] ⏱ surf-ai done: 1 round(s), 5 queries, 49 source(s), 154970ms
```

The format is stable for grep/parse. Use `--quiet` or `SURF_QUIET=1` to
silence (CI, piping, tests). Stdout stays clean either way.

---

## Multi-key & fallback

`~/.config/surf/keys.json` holds **four** provider sections — three search
providers plus `openrouter`, the LLM surf-ai runs on. They share the same
rotation machinery; `openrouter` is deliberately absent from every search
capability chain, so a search can never be routed to it.

```
keys.json (per provider — tavily | parallel | brave | openrouter):
  keys:       [key0, key1, key2]
  current:    1                       ← starts here next call
  burned:     [{ index: 0, reason: "401", at: "2026-05-15..." }]
                                      ← auto-reset on the 1st of next month
  cooldowns:  [{ index: 2, until: "2026-05-15T12:34:56Z" }]
                                      ← after a 429; persists across runs

search call flow:
  ┌─ load state, auto-reset burned ──┐
  │                                  │
  └─▶ chain = [last_ok_provider,    ─┤
              ...rest_of_capability_chain]
                                     │
  for provider in chain:             │
    for key in usable_keys(provider):│
      try call                       │
        200 ─▶ save last_ok, return  │
        401/403/402 ─▶ burn key, next│
        5xx x3 ─▶ burn key, next     │
        429 ─▶ backoff, retry        │
        4xx ─▶ raise (no fallback)   │
    (no usable keys) ─▶ next provider│
  raise AllProvidersExhausted ───────┘

surf-ai adds one more rung under that:
  AllProvidersExhausted ─▶ keyless tier (wikipedia → ddg) ─▶ ledger row "FAILED"
  …and a failed search is never dropped — it stays in the ledger with its reason.

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

Force a specific provider for debugging:

```bash
surf-research-skill search "x" --provider parallel
# 'parallel' fails ⇒ command fails (no fallback when --provider is set)
```

`surf-ai` ignores `--provider` by design — falling back is the whole point.

---

## Onboarding

`surf-research-agent-skill` needs an API key. (For free, no-key search, use the
separate **`surf-free-agent-skill`** — no setup at all.)

```bash
# 1. Wizard (recommended in a TTY) — prompts Tavily, Parallel, Brave, OpenRouter
surf-research-skill setup
surf                                   # same thing, with a menu

# 2. surf-ai's LLM key on its own (validation is FREE — key introspection,
#    zero tokens, zero credits)
surf-research-skill ai-setup
surf-research-skill ai-setup --key sk-or-v1-...     # non-interactive
surf ai-key

# 3. Direct — many keys per provider in one call (each live-validated)
surf-research-skill keys add --provider tavily tvly-AAA tvly-BBB tvly-CCC
surf-research-skill keys add --provider openrouter sk-or-v1-AAA sk-or-v1-BBB
cat parallel-keys.txt | surf-research-skill keys add --provider parallel --stdin

# 4. Auto-launch in a TTY: run any command without keys
surf-research-skill search "test"
# → in a TTY with no search keys: launches the setup wizard
# (the surf-ai commands never hijack your run this way — they degrade instead)

# Free, no-key search (separate skill, zero setup):
surf-free-skill "your query"

# 5. Environment / library mode
TAVILY_API_KEY=tvly-... node -e "import('surf-agent-skill').then(m => m.search('x'))"
export OPENROUTER_API_KEY=sk-or-v1-...   # picked up by surf-ai, never persisted
export OPENROUTER_API_KEYS=sk-a,sk-b     # …and rotated like any other key list
```

Inspect what was stored (keys are masked):

```bash
surf-research-skill keys list
# **Surf keys** (config: ~/.config/surf/keys.json)
# last_ok_provider: `tavily`
# ## tavily (2 keys)
# - [0] tvly-…ab12  *(current)*
# - [1] tvly-…cd34
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
→ Every search failed, keyed *and* keyless. The report lists what was tried
and why. Usually: all search keys burned (`keys list` → `keys reset`), or the
harness killed the calls (raise the timeout, see above).

**Answer looks generic / doesn't address my situation**
→ You didn't pass the brief. `--task`, `--goal` and `--insights` are what turn
"tell me about X" into an answer aimed at your actual decision.

**`surf-search-unlimit` was killed mid-run**
→ It enforces no deadline of its own; the *harness* did. Give the Bash call an
explicit long timeout (Claude Code: `timeout: 600000`), run
`surf-research-skill project-config`, or use `surf-search-normal`.

**Cost is higher than expected**
→ The footer prints the real spend. Reduce `--max-rounds`, `--max-queries`, or
pass `--ai-model deepseek/deepseek-v4-flash-0731` (same 1M context, roughly a
third of the price).

### Search / keys

**`❌ Error [NoProviderAvailable]: operation 'X' requires one of [...]`**
→ The op needs a key for a provider you haven't configured. In a TTY the
error already suggests `surf-research-skill setup`. Outside TTY, run
`surf-research-skill keys add --provider <name> <key>`.

**`❌ Error [AllProvidersExhausted]: ...`**
→ Every key on every eligible provider failed. Check `surf-research-skill keys list`
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

**`Refusing sync research with model=pro`**
→ Use `surf-research-skill research-start --model pro ...` then `surf-research-skill
research-poll <id>`. Sync research is capped at 50 s on purpose.

---

## Repository layout (v5.4.0)

```text
.
├── package.json                       ← name: surf-agent-skill (npm), version 5.4.0, 6 bins
├── README.md           ← you're here
├── CHANGELOG.md
├── LICENSE
├── logo.png
├── SKILL.md                           ← surf-research-agent-skill / surf-ai (root of pkg)
├── bin/
│   ├── surf.mjs                       ← interactive setup + key validation
│   ├── surf-search-normal.mjs         ← surf-ai, ONE round (fits the bash timeout)
│   ├── surf-search-unlimit.mjs        ← surf-ai, rounds until resolved
│   ├── surf-research-skill.mjs        ← multi-provider web research CLI + `ai` subcommands
│   ├── surf-free-skill.mjs            ← keyless search CLI
│   └── surf-plan-skill.mjs            ← planning workflow CLI
├── skills/
│   ├── surf-plan-agent-skill/SKILL.md       ← planning (auto-routes to an ambiguity-sweep mode)
│   ├── surf-free-agent-skill/SKILL.md       ← free keyless search
│   └── surf-research-skill/SKILL.md   ← mirror of the root SKILL.md
├── test/
│   └── smoke.mjs                      ← offline suite: stubs fetch, temp HOME, 95 assertions
├── src/
│   ├── index.mjs                      ← library entry (search/extract/research/...)
│   ├── env.mjs                        ← key discovery (opts > env > .env > config)
│   ├── plan/                          ← plan-file, plans-dir, slug (planning lib)
│   ├── validators/                    ← per-provider key validators (live API)
│   ├── lib/
│   │   ├── ai/                        ← surf-ai — the whole research loop
│   │   │   ├── orchestrator.mjs       ← plan → search → analyze → loop → synthesize
│   │   │   ├── openrouter.mjs         ← LLM client: model chain, key rotation,
│   │   │   │                            schema downgrade, loose JSON parsing
│   │   │   ├── prompts.mjs            ← the 3 stage prompts + strict JSON schemas
│   │   │   ├── ledger.mjs             ← coverage rows, source dedupe, digest budget
│   │   │   ├── heuristics.mjs         ← deterministic LLM-free fallbacks
│   │   │   ├── render.mjs             ← markdown / JSON output
│   │   │   ├── cli.mjs                ← shared command impl for all 3 entry points
│   │   │   └── setup.mjs              ← `ai-setup` OpenRouter key wizard
│   │   ├── state.mjs                  ← ~/.config/surf/keys.json I/O (4 providers)
│   │   ├── cache.mjs                  ← TTL response cache
│   │   ├── audit.mjs                  ← audit + usage JSONL
│   │   ├── flags.mjs, cost.mjs, format.mjs
│   │   ├── dispatch.mjs               ← provider/key fallback + self-budget (+ --no-budget)
│   │   ├── pool.mjs                   ← bounded-concurrency worker pool
│   │   ├── keys-cmd.mjs               ← surf-research-skill keys add/remove/...
│   │   ├── setup.mjs                  ← interactive onboarding (with validation)
│   │   ├── project-config.mjs         ← surf-research-skill project-config
│   │   ├── progress.mjs               ← stderr progress events
│   │   ├── check-surf-agent-skill.mjs       ← detect companion CLI in PATH
│   │   ├── harness-install.mjs        ← cross-OS symlink install for 3 skills
│   │   ├── api/                       ← library search/extract/crawl/map/research
│   │   └── providers/
│   │       ├── index.mjs              ← capability map (search + 3 providers)
│   │       ├── tavily.mjs
│   │       ├── parallel.mjs
│   │       ├── brave.mjs
│   │       ├── wikipedia.mjs          ← keyless
│   │       └── ddg.mjs                ← keyless
│   └── install/
│       ├── postinstall.mjs            ← cross-OS symlinks + skeleton keys.json
│       └── preuninstall.mjs           ← cleanup our symlinks
└── references/
    ├── tavily-api.md
    ├── parallel-api.md
    ├── plan-workflow.md               ← deeper docs on the planning workflow (Normal + Deep ambiguity-sweep mode)
    └── COSTS.md
```

---

## Security

- This repository contains **no real API keys**. The installer only uses
  placeholders.
- **Keys are only ever persisted to `~/.config/surf/keys.json`** (chmod 600).
  Nothing else on disk ever holds one.
- **CLI mode** reads search-provider keys (Tavily / Parallel / Brave) from that
  file and from nowhere else — not from the environment, not from `.env`. The
  **OpenRouter** key is the one exception: `OPENROUTER_API_KEY` /
  `OPENROUTER_API_KEYS` are also accepted so surf-ai works on machines that
  already export one. Env-sourced keys are used **in memory only** and are
  stripped back out before any write to `keys.json` (`snapshotForPersist`,
  `src/lib/ai/openrouter.mjs`).
- **Library mode is different by design.** `discoverKeys()` (`src/env.mjs`),
  which every `import { search, … } from 'surf-agent-skill'` call goes through,
  resolves keys for *all* providers in this order: explicit options →
  `process.env` (`TAVILY_API_KEY(S)`, `PARALLEL_*`, `BRAVE_*`, `OPENROUTER_*`)
  → a `.env` in the current working directory → `keys.json` as a last resort.
  That is what makes it usable from serverless and CI. Pass
  `skipDotenv: true` / `skipConfigFile: true` to switch those levels off.
- The audit log records only `provider` name and key **index**, never the
  key itself. `surf-research-skill keys list` masks every key (`tvly-…ab12`).
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
