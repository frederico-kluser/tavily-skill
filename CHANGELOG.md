# Changelog

## v5.4.0 — surf-ai: the research loop moves out of the agent and into the CLI

The headline change: **the calling agent no longer orchestrates research.**
Previous versions handed the agent a toolbox plus a 600-line SKILL.md
explaining how to classify a question, decompose it, write a query array, fan
it out, read the harvest, decide what was missing, and loop. All of that is now
code, driven by an LLM, inside the CLI.

The agent's job is now two things: **write a brief**, and **pick one of two
modes**.

### Added

- **`surf-search-normal`** (new bin) — one research round, fitted inside the
  harness's bash timeout so it returns an answer instead of being killed.
  Two LLM calls (plan, synthesize). Typical: 45–110 s, ~$0.01–0.03.
- **`surf-search-unlimit`** (new bin) — as many rounds as the question needs.
  After each round the LLM lists what is still open and writes the next
  round's queries; it stops when the analyst reports the success criteria met,
  when it has no new queries, or at `--max-rounds` (default 6, cap 50). No
  self-imposed deadline.
- **`surf-research-skill ai <question> --mode normal|unlimit`** — the same
  engine as a subcommand. All three entry points share one implementation
  (`src/lib/ai/cli.mjs`) so they cannot drift.
- **The brief** — `--task`, `--goal`, `--insights`, `--deliverable`, or
  `--brief-file <f.json>` for long multi-line briefs. `--insights` is fed to
  the planner as *hypotheses to falsify*, not as facts, so a run can tell the
  agent it was about to build on a wrong premise.
- **`surf-research-skill ai-setup`** / **`surf ai-key`** — the one-question
  wizard for the OpenRouter key. Validation is free (GET `/api/v1/key`, zero
  tokens, zero credits). Also accepts `--key` for non-interactive use, and
  multiple keys for rotation.
- **`openrouter` is now a first-class key provider** in `keys.json`, inheriting
  the existing machinery: multi-key rotation, burn-on-auth-failure, monthly
  un-burn, and 429 cooldowns. It is deliberately absent from every search
  `capabilityMap` chain, so a search dispatch can never route to it.
- **`OPENROUTER_API_KEY` / `OPENROUTER_API_KEYS` are read from the
  environment** — used in memory only and stripped before any write to
  `keys.json`, so an exported key never gets silently persisted. Search-provider
  keys remain file-only.
- **`test/smoke.mjs` + `npm test`** — 103 offline assertions covering loose JSON
  parsing, the error taxonomy, `Retry-After` parsing, ledger dedupe/truncation,
  the heuristic fallbacks, brief building, boolean-flag parsing, env-key
  stripping, output rendering, and the full orchestrator loop (normal, unlimit,
  repeated-query suppression, total LLM outage, partial search failure, and
  zero-evidence). Runs against a stubbed `fetch` under a throwaway `HOME` — no
  network, no keys, no touching the user's config.

### How surf-ai handles failure (the point of the feature)

Nothing in the loop hands the agent an error to handle:

- **Model chain** — `deepseek/deepseek-v4-pro` → `v4-flash-0731` → `v4-flash`
  → `v3.2` → `chat-v3.1`. Every slug was verified live against
  `GET /api/v1/models` on 2026-08-01 to have serving endpoints and
  `structured_outputs` support. (`deepseek/deepseek-v3.2-speciale` is listed on
  the provider page but returns an **empty endpoints array**, so it is
  excluded — requesting it fails with no-available-provider.)
- **Key rotation** — every non-burned, non-cooling OpenRouter key is tried;
  401/402/403 burns the key and rotates, 429 honors `Retry-After` then cools
  the key.
- **Schema downgrade** — `provider.require_parameters: true` makes OpenRouter
  answer **404** (not 400) when no endpoint implements `json_schema`. That is
  now mapped to a schema downgrade, not to "unknown model", so a good model
  isn't discarded over a schema it can still answer in plain text. 503 under
  the same constraint downgrades before being treated as an outage.
- **Loose JSON parsing** — fenced blocks, prose preambles, trailing
  commentary, and braces inside strings all parse.
- **Keyless search fallback** — when every keyed search provider is exhausted,
  surf-ai drops to the free Wikipedia + DuckDuckGo tier rather than failing.
- **Deterministic fallbacks** — no LLM at all still produces a real,
  cited evidence brief from real searches, labelled `⚠ Degraded mode`.
- **Failures are ledger rows** — a failed search is recorded with its reason,
  never silently dropped, so coverage claims stay honest.
- Exit codes: `0` = an answer (possibly degraded), `1` = nothing retrieved at
  all, `2` = usage error, `143` = the harness killed it.

### Changed

- **Root `SKILL.md` rewritten** around surf-ai. The mode router, decomposition
  protocol, query-craft guidance, fan-out gate, wave cap and Research Ledger
  template are gone from the agent's instructions — the CLI owns them now.
  What replaced them: how to write the brief, how to choose between the two
  modes, how to read the footer and the degradation labels, and a compact
  manual toolbox for the cases surf-ai doesn't cover (`extract` a known URL,
  `map`/`crawl` a doc site, Parallel's async Task API).
- **`surf-plan-skill`** — Layer A is now `surf-search-normal` with a planning
  brief; the raw commands moved to a new "Layer A-manual" tier for when you
  want hits without synthesis. Phase 3, Phase 4D and Phase 6 examples updated.
- **`surf` bundle CLI** — new `ai-key` command, a surf-ai section in `doctor`
  (including whether an env key was detected), and the interactive menu grew an
  "Add the OpenRouter key" entry.
- **`surf-research-skill setup`** now prompts for an OpenRouter key alongside
  the three search providers, and its cheat sheet leads with the surf-ai
  commands.
- **Budget detection** — when no harness declares a bash timeout, normal mode
  budgets **110 s** instead of the 30 s guess `dispatch()` uses for a single
  search, and says so on stderr. A plan + fan-out + synthesis cannot happen in
  30 s, and every mainstream harness allows more (Claude Code defaults to 120 s
  and, since v2.1.210, backgrounds rather than kills on timeout; Pi core
  enforces none). A *measured* budget is always honored as-is, and
  `--budget-ms` / `SURF_AI_BUDGET_MS` override everything.
- **`parseFlags` bug fix** — boolean switches (`--json`, `--ledger`, `--quiet`,
  `--no-cache`, `--no-fallback`, `--no-budget`, `--confirm-expensive`, `--yes`,
  `--all`, `--stdin`, `--skip-validate`, `--reset`, `--raw-json`) no longer
  swallow the following argument. `surf-search-normal --json "my question"`
  used to set `flags.json = "my question"` and then report the question
  missing. Dual-use flags (`--answer`, `--raw`) are deliberately excluded, so
  existing search behavior is unchanged.
- **README corrected on four long-standing false claims** (found by auditing
  it against the source): the installer does **not** write `~/.claude/settings.json`
  or any harness timeout config — it only symlinks skills and creates
  `keys.json`; nothing has ever written `~/.copilot/skills/` (Copilot reads
  `~/.agents/skills/`); nothing has ever written `~/.config/opencode/opencode.json`;
  and the security claim "keys are never read from env" was only true of the
  CLI — library mode reads `process.env` and `.env` by design. The
  `--mode` collision between the toolbox (`fast|normal|slow`) and
  `surf-research-skill ai` (`normal|unlimit`) is now called out explicitly.
- `state.mjs` exports `SEARCH_PROVIDERS` alongside `PROVIDERS`, so "has a
  search key" checks don't accidentally count the LLM key.
- `env.mjs` key discovery is now generic over the provider list instead of
  hard-coding three providers.
- `package.json`: 6 bins, a `./ai` export, `npm test`, and `test:syntax` now
  globs `bin/*.mjs` and `src/lib/ai/*.mjs`.
- Version strings converge on **5.4.0** across every bin, skill and doc.

### New environment variables

`SURF_AI_MODEL` · `SURF_AI_BUDGET_MS` · `SURF_AI_MAX_TOKENS` ·
`SURF_AI_TIMEOUT_MS` · `SURF_AI_COOLDOWN_MS` · `SURF_OPENROUTER_BASE`

### Notes

- Existing `keys.json` files are upgraded automatically — the `openrouter`
  section is added by the normalizer on first load. No migration step.
- Every pre-existing command (`search`, `search-parallel`, `extract`, `crawl`,
  `map`, `research*`, `keys`, `cost`, `cache-clear`, `project-config`) is
  unchanged and still supported.

## v5.3.0 — close-the-loop follow-ups + delegated research (subagent/swarm) mode

Adds two behavioral upgrades across all three installed skills (docs-only, no
code changes).

### Added

- **Close-the-loop follow-ups** — all three skills now instruct the agent to
  end every answer with 2-3 concrete follow-ups the findings raised and offer
  to run them, instead of answering once and going silent. If findings change
  the user's original question, the agent says so and asks before closing.
  (`surf-research-skill` SKILL.md § "Close the loop — don't stop at the
  answer"; `surf-plan-skill` Phase 5/5D + "Deliver the plan" reinforcements;
  `surf-free-skill` § "Keep the loop going".)
- **Delegated research (subagent/swarm) mode** — when the harness exposes a
  subagent tool (Agent / Task / AgentSwarm), `surf-research-skill` and
  `surf-plan-skill` instruct delegating research and validation to a subagent
  or a 1-per-angle swarm that returns validated findings (2+ sources per key
  claim, dates checked, contradictions flagged, plus detected new doubts).
  The main agent reviews the returns; new doubts become the next wave's
  targets within the **existing 3-wave cap**. Without a subagent tool, the
  inline Layer A/B path stays as the fallback — delegated mode is an option,
  never a requirement.
- **Progress checklists** — `surf-research-skill` gains R9 (follow-ups
  offered); `surf-plan-skill` (Normal and Deep) gain a follow-up checklist
  item.

### Changed

- Root `SKILL.md`, `skills/surf-plan-skill/SKILL.md`,
  `skills/surf-free-skill/SKILL.md`, `README.md` (3 version strings),
  and `package.json` bumped to **5.3.0** (all versioned files converge).
  Legacy `skills/surf-research-skill/SKILL.md` received the two new sections
  verbatim (version stays 5.0.0; pre-existing drift unchanged).
- `surf-research-skill` mandatory rules now number 15 (added rules 14 and 15
  for close-the-loop and delegation preference); anti-patterns section gains
  "answering once and going silent" and "delegating without a validation
  contract."
- No frontmatter `description` or trigger changed. No `.mjs` code modified.

## v5.2.0 — new surf-free-skill (free, keyless search) + rotation hardening

Adds a **third skill, `surf-free-skill`**: free, keyless web search over
**Wikipedia + DuckDuckGo** — no API key, no setup. It is deliberately SEPARATE
from `surf-research-skill` (which stays keyed-only), so the two never mix — use
`surf-free-skill` for free/no-key lookups and `surf-research-skill` for real
general-web research. This release also hardens key rotation across the board.

### Why

The goal is a tool that returns *something* useful before onboarding, then gets
better as keys are added. Deep research into the keyless landscape (sources
below) settled the provider choice — and a **live probe corrected the docs**:
DuckDuckGo's Instant Answer API is *not* a general-web search API (blank for
most non-entity queries), and Jina's `s.jina.ai`, though widely documented as
keyless, now returns `401 AuthenticationRequiredError`. The verified,
reliably-keyless pair is **Wikipedia's MediaWiki search API** (broad
encyclopedic full-text, returns hits for almost any informational query) plus
**DuckDuckGo IA** (instant answers / entities) as the final safety net. Bing's
API is retired (Aug 2025) and Google Custom Search is closed to new customers,
so neither is an option.

### Added

- **`surf-free-skill`** — new skill + bin (`bin/surf-free-skill.mjs`,
  `skills/surf-free-skill/SKILL.md`): keyless `search` over `wikipedia → ddg`.
  New providers `src/lib/providers/wikipedia.mjs` and `ddg.mjs` (`keyless: true`),
  reached via a dedicated `flags.keyless` dispatch path — NOT part of
  surf-research-skill's chain. Registered in `package.json` bin,
  `harness-install.mjs` (symlinked on install), and the `surf` wrapper.
- **Bulk `keys add`** (`src/lib/keys-cmd.mjs`): `keys add --provider X k1 k2 k3`
  adds many keys of one provider in a single call (validated in parallel), and
  `--stdin` reads newline-delimited keys (`cat keys.txt | … keys add --stdin`).
- **Per-key 429 cooldown**: a key that exhausts its rate-limit retries is
  sidelined for 60s (persisted in `keys.json`, override via
  `SURF_RATE_LIMIT_COOLDOWN_MS`) so it isn't hammered on the next run. New
  `cooldowns[]` state field + `setCooldown`/`cooldownActive` helpers
  (`src/lib/state.mjs`).
- **Keyless visibility**: `keys list` and `surf doctor` show the always-on
  `wikipedia, ddg` fallback; `keys list` also flags a `cooling` key.

### Changed

- **Backoff now includes jitter** (`src/lib/dispatch.mjs`): capped exponential
  backoff + "equal jitter" (half fixed, half random), which sharply reduces
  synchronized retry storms across many keys/clients (AWS guidance below).
- Dispatch special-cases keyless providers (undefined key; never written to
  `keys.json`; never set as `last_ok_provider`). They are NOT in any
  `capabilityMap` chain, so `surf-research-skill` stays keyed-only and still
  errors `NoProviderAvailable` with no keys — the free tier lives only in
  `surf-free-skill`.
- Version bumped to 5.2.0 across all pinned locations.

### Sources consulted

- [DuckDuckGo Instant Answer API](https://duckduckgo.com/duckduckgo-help-pages/features/instant-answers-and-other-features) — "not a full search results API … beyond our instant answers"; blank for most non-topic queries.
- [MediaWiki API:Search](https://www.mediawiki.org/wiki/API:Search) — keyless full-text search; requires a descriptive User-Agent.
- [Jina Reader/Search](https://jina.ai/reader/) — documents `s.jina.ai`; live probe now returns `401 AuthenticationRequiredError` (key required), so Jina was rejected for the keyless skill.
- [AWS — Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) — jitter "reduced our call count by more than half" under contention.
- [Brave drops free Search API tier](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/) (Feb 2026) — why no keyed provider is free anymore.
- [Bing Search API retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) (Aug 2025) and [Google Custom Search JSON](https://developers.google.com/custom-search/v1/overview) (closed to new customers) — ruled out.
- SearXNG ([API](https://docs.searxng.org/dev/search_api.html), [searx.space](https://searx.space/)) — JSON disabled by default; all public instances probed returned 403/429, so not usable keyless.

### Migration

```bash
npm i -g surf-agent-skill@latest
surf-free-skill "your query"        # free, keyless — no key needed
surf-research-skill --version       # 5.2.0 (still requires a key)
```

No config changes required. Existing `keys.json` files gain a `cooldowns: []`
field automatically on next load.

## v5.0.0 — consolidation: 4 skills → 2, mode routers, provider deep-dive

The 4-skill lineup from v4.2.0 asked the calling agent to pick the right
tool up front (`surf-search-skill` vs `surf-parallel-skill`,
`surf-plan-skill` vs `surf-deep-plan-skill`) based on trigger-phrase
matching. This release removes that choice: each remaining skill now reads
the request itself and routes to the right depth internally.

### Why

Skill selection by trigger phrase is fragile — two near-duplicate skill
descriptions competing for the same kind of request is exactly the pattern
Anthropic's own multi-agent research write-up warns against ("teach the
orchestrator how to delegate" only works when there's one delegator making
one decision, not several similarly-worded tools hoping to get picked). The
fix is architectural: fold the "deep" variant into the "normal" skill as an
explicit, stated decision (a Mode Router / Mode Decision phase), instead of
shipping it as a separate skill file. This also gave us the excuse to
actually research how to get more out of Tavily and Parallel AI rather than
just renaming files — see Sources below.

### Breaking changes

- **`surf-search-skill` → `surf-research-skill`.** Skill name, npm bin,
  `allowed-tools` entries, symlinks, and every doc reference renamed.
  Scripts calling `surf-search-skill <subcommand>` must switch to
  `surf-research-skill <subcommand>`.
- **`surf-parallel-skill` removed** — its fan-out protocol (fan-out gate,
  Research Ledger, source-category-diverse queries, dedup/contradiction
  rules) is now `surf-research-skill`'s **Parallel**/**Deep** mode, chosen
  automatically by the new Mode Router.
- **`surf-deep-plan-skill` removed** — its ambiguity sweep (taxonomy, EARS
  gap test, two-implementations test, two-lock gate) is now
  `surf-plan-skill`'s **Deep** mode, chosen automatically by the new Mode
  Decision phase (or still explicitly requested: "raise all my doubts
  first", "levante todas as dúvidas").
- `harness-install.mjs::SKILLS` now lists 2 entries instead of 4;
  `LEGACY_NAMES` gained `surf-search-skill`, `surf-parallel-skill`,
  `surf-deep-plan-skill` so upgrading cleanly removes the old symlinks
  before creating the new ones (same discipline as the v4.0.0 rename).
- npm package name is unchanged (`surf-agent-skill`); `npm i -g surf-agent-skill`
  continues to work and now installs 2 skills + 3 bins.

### Added

- **Mode Router (`surf-research-skill`)**: resolves harness class
  (no-limit/Pi vs time-limited) and query complexity (one fact → **Normal**;
  2-5 angle comparison → **Parallel**; broad/exhaustive → **Deep**), then
  states the chosen mode before doing anything. On a no-limit harness, Deep
  mode can genuinely **iterate** — up to 3 waves, evaluating the Research
  Ledger for gaps between waves — mirroring the "lead agent decides whether
  more research is needed" loop from Anthropic's Research system, which is
  safe here specifically because Pi core has no bash timeout to race
  against. Hard-capped at 3 waves; time-limited harnesses never iterate.
- **Mode Decision (`surf-plan-skill`)**: after project discovery, decides
  Normal vs Deep from explicit request, reversibility, or a genuine
  divergence between two plausible implementations — instead of the user
  needing to know a second skill name exists.
- **"How to research and resolve a technical doubt"** — a new, much more
  detailed protocol in `surf-plan-skill`: query craft (start wide then
  narrow, <400 chars), source-category diversity (vendor docs / community /
  spec / advisory / benchmark / primary research), and a fixed
  contradiction-resolution order (recency > authority > corroboration).
- **Full Parallel Task API processor documentation.** `--processor <tier>`
  was already accepted by `research`/`research-start` (passed straight
  through `dispatch` → `researchStart`) but entirely undocumented — `--model`
  only ever exposed 4 of the real 9 tiers. Now documented in
  `references/parallel-api.md`, `references/COSTS.md`, the CLI `--help`
  text, and `surf-research-skill`'s own SKILL.md: `lite`, `base`, `core`,
  `core2x`, `pro`, `ultra`, `ultra2x`, `ultra4x`, `ultra8x`, each with a
  `-fast` variant (2-5x lower latency, trades absolute freshness for speed).
- **Tavily query-optimization guidance** added to `references/tavily-api.md`
  and `surf-research-skill`'s SKILL.md: the 400-character query guideline,
  chunks-vs-content selection, `exact_match` usage, and the
  search-then-extract two-step pattern — all from Tavily's own
  best-practices docs.
- Fixed a version-drift bug found while bumping: `src/lib/dispatch.mjs` and
  `src/validators/index.mjs` had been stuck at `VERSION = '3.0.1'` since
  v3.0.1 despite the CHANGELOG claiming these were bumped in v4.0.0; both
  now correctly read `5.0.0` (affects the `X-Client-Name` header sent to
  providers).

### Sources consulted

- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic, Jun 2025) — "scale effort to query complexity", "teach the orchestrator how to delegate", "start wide, then narrow", parallel tool calling, and the guardrail against unbounded iteration all trace to this post.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic, Sep 2025).
- [Tavily — Best Practices for Search](https://docs.tavily.com/documentation/best-practices/best-practices-search).
- [Parallel — Choose a processor](https://docs.parallel.ai/task-api/guides/choose-a-processor).

### Migration

```bash
npm i -g surf-agent-skill@latest

# Verify:
surf --version                  # 5.0.0
surf-research-skill --version   # 5.0.0 (was surf-search-skill)
surf-plan-skill --version       # 5.0.0

# Update any scripts:
#   surf-search-skill ...  →  surf-research-skill ...

# Check symlinks (old 4-skill set replaced by 2; legacy ones auto-removed):
ls ~/.claude/skills/   # surf-research-skill + surf-plan-skill (no surf-search-skill,
                       #  no surf-parallel-skill, no surf-deep-plan-skill)
```

No behavior your agent relied on was removed — the parallel fan-out
protocol and the ambiguity sweep both still exist, just as internal modes
instead of separate skills you had to know to ask for.

## v4.2.0 — parallel fan-out, two new skills, and the Pi no-limit stance

Adds a real **parallel search** path and two skills tuned for it, and corrects
the project's stance on **Pi Coding Agent timeouts**.

### Added

- **`surf-search-skill search-parallel`** — fan out MANY searches concurrently
  through a zero-dep, bounded-concurrency worker pool (`src/lib/pool.mjs`:
  N workers drain a shared cursor; each task is try/caught so one failure never
  kills a worker — the p-limit + `Promise.allSettled` pattern). Flags:
  `--concurrency <n>` (default 6, cap 16), `--queries-file <F.json>` (JSON array
  of strings or `{q,id,sub}` objects, or a newline list). Output groups by
  sub-question. Partial-failure tolerant: a 429 rotates keys/backs off inside
  the call; the command exits non-zero only when EVERY query failed. State is
  loaded once and shared across workers (per-call persistence suppressed, then
  persisted once) so burned keys are visible immediately and there is no
  lockfile thrash.
- **`extract --urls-file <F.json>`** — read URLs from a JSON array
  (`["u", {"url":"u"}]`) or newline list, in addition to positional URLs.
- **`searchParallel(queries, opts)`** library export (`opts.concurrency`,
  `opts.noBudget` default true for library callers).
- **`--no-budget` flag / `SURF_NO_TIMEOUT=1` / `SURF_AGENT_BUDGET_MS=0`** —
  disables the self-budget abort and lets each request use the provider's own
  per-request ceiling (`SURF_TIMEOUT_MS` || 45 s) instead of the detected
  harness bash timeout. For no-limit harnesses only (e.g. Pi core).
- **`surf-parallel-skill`** (new skill) — maximum-information parallel research:
  decompose → diverse queries per sub-question → `search-parallel` fan-out →
  extract top hits → dedupe → cited synthesis, behind a **fan-out gate** (no
  sub-question silently dropped). Triggers narrowed to broad/deep intent so it
  does not collide with `surf-search-skill` on simple lookups.
- **`surf-deep-plan-skill`** (new skill) — ambiguity-exhaustive, research-grounded
  planning: a mandatory **ambiguity sweep** (taxonomy + EARS gap test +
  two-implementations divergence test) and a **two-lock gate** (ambiguity lock +
  research lock) on top of the existing plan workflow. Triggers narrowed to
  "raise all doubts first" / "levante todas as dúvidas" so it does not collide
  with `surf-plan-skill`, which it cross-references for routine plans.

### Changed

- **Pi no-limit stance (reconciled across README, root `SKILL.md`,
  `project-config`).** Pi *core* applies **no** bash timeout; the previous docs
  treated it as 120 s/600 s. The `PI_BASH_*` env vars only bind the optional
  `pi-bash-timeout` extension (where `project-config` raises its cap to
  300 s/600 s). surf can't detect Pi from the environment, so it still
  self-guesses 30 s worst-case and self-aborts — hence `--no-budget` for known-
  long calls on Pi. `dispatch.detectHarnessBudgetMs()`/`detectHarnessName()` now
  take `flags` and return `Infinity`/`'no-limit …'` when opted out; the worst-
  case 30 s default for *unknown* harnesses is unchanged (Copilot safety).
- `dispatch` never passes `Infinity` as an HTTP timeout (Node clamps it to ~1 ms
  and would abort immediately); unlimited → `undefined` → provider default.
- Skills registered in `harness-install.mjs` (now 4 skills symlinked per
  harness); version bumped to 4.2.0 across bins, `package.json`, postinstall,
  and all `SKILL.md` metadata.

### Why

`search "a" "b" "c"` runs **sequentially** by design (rate-limit safety). Broad
research and ambiguity-first planning want genuine concurrency; `search-parallel`
provides it without sacrificing key rotation, fallback, or partial-failure
tolerance. And on a harness with no bash timeout (Pi core), the self-budget
abort was the only thing capping long fan-outs — `--no-budget` removes it
deliberately, only where the user knows it is safe.

## v4.1.0 — surf-plan-skill: enforce research before ANY plan (plan-mode fix)

### The bug

`surf-plan-skill` delivered plans **without running any web research**,
especially when the plan was presented for user approval (Claude Code
plan mode / `ExitPlanMode`). The skill's whole value — research-grounded
plans — silently didn't happen.

### Root causes (three, stacking)

1. **Plan mode blocks Bash.** The skill's only research mechanism was
   the `surf-search-skill` CLI via the Bash tool. Harness plan modes —
   the exact modes that present a plan for approval — block Bash (and
   Write) entirely, allowing only read-only tools (Read, Glob, Grep,
   WebSearch, WebFetch, AskUserQuestion). The agent triggered the
   skill, found Bash blocked, skipped research, and presented an
   unresearched plan for approval. The SKILL.md said nothing about
   approval modes or fallbacks, and its Phase 0 "halt if the CLI is
   unreachable" rule turned every Bash restriction into a dead end.
2. **Invalid `allowed-tools` frontmatter.** Both skills listed
   lowercase tool names (`bash, read, glob, grep, edit, write`). Claude
   Code tool names are PascalCase (`Bash`, `Read`, …) and matching is
   case-sensitive, so nothing was actually pre-approved — every
   research call hit a permission prompt, adding friction that nudged
   agents toward skipping searches.
3. **No verifiable gate.** The 6-phase workflow was descriptive prose;
   nothing forced the agent to produce evidence that research happened
   before the plan went out. Anthropic's skill-authoring guidance:
   models skip steps unless you add checklists + verifiable
   intermediate outputs.

### Fix

`skills/surf-plan-skill/SKILL.md` rewritten (v4.1.0):

- **THE GATE**: the agent may not present, write, file, or submit a
  plan — through any channel, including `ExitPlanMode`/plan-approval
  tools — until the Research Ledger shows the Phase 2 baseline batch
  (≥3 queries) and the Phase 5 synthesis batch (≥2 queries), plus one
  search per clarifying question. The only bypass is the user
  explicitly accepting a plan labeled "NOT WEB-RESEARCHED".
- **Layered research (A→B→C)**: Layer A = `surf-search-skill` via Bash
  (preferred); Layer B = harness-native WebSearch/WebFetch (Bash
  blocked/denied/missing — e.g. plan mode); Layer C = nothing available
  → halt and let the user decide. **A blocked layer means fall back,
  never skip.** Mid-flow Layer A failures downgrade to B.
- **Plan-approval mode integration**: Phases 0–5 run BEFORE the
  approval tool is called; the submitted plan embeds Decisions-with-
  citations + Research Ledger; the plan file is written immediately
  after approval (Write is blocked before).
- **Progress checklist** the agent copies into its response and updates
  (skipped phases become visible), per Anthropic best practices.
- **Research Ledger** — new required plan section: one row per query
  (phase, layer, query, footnotes used). Every Decision footnote must
  trace to a ledger row; fabricated ledgers are called out as the worst
  anti-pattern.
- **Frontmatter**: `allowed-tools` fixed to valid PascalCase scoped
  rules (`Bash(surf-search-skill:*), Bash(surf-plan-skill:*), Read,
  Glob, Grep, Write, Edit, WebSearch, WebFetch, AskUserQuestion`);
  description rewritten to be directive ("MUST BE USED … BEFORE any
  plan is presented for approval"), mention plan mode, and include
  Portuguese trigger phrases ("faça um plano", "planeje isso", …);
  added `argument-hint`.
- Phase 0 no longer hard-halts when the CLI is missing — it resolves
  the best available layer; only Layer C halts (user's call).

Root `SKILL.md` (search skill): `allowed-tools: bash` →
`Bash(surf-search-skill:*), Bash(surf:*)` (same casing bug, scoped).

### Files changed

- `skills/surf-plan-skill/SKILL.md` — rewritten (gate, layers,
  plan-mode integration, checklist, ledger, frontmatter).
- `SKILL.md` — `allowed-tools` casing/scoping fix + version.
- `references/plan-workflow.md` — documents the gate, layers, and
  plan-approval-mode behavior; updated phases and anti-patterns.
- `bin/surf-plan-skill.mjs` — help text reflects the new Phase 0/6 and
  THE GATE; `VERSION` → `4.1.0`.
- `bin/{surf,surf-search-skill}.mjs`, `src/install/postinstall.mjs`,
  `package.json`, `README.md` — version bump + gate note in README.

### Upgrading

```bash
npm i -g surf-agent-skill@latest
surf-plan-skill --version    # 4.1.0
```

Then ask your agent for a plan (plan mode included) — it must show the
progress checklist, run the searches (or visibly fall back to
WebSearch), and the delivered plan must contain a Research Ledger.

## v4.0.1 — fix missing `surf-search-skill` bin after v4.0.0 rename

### The bug

`npm i -g surf-agent-skill@4.0.0` installed the package but did **not** create
the `surf-search-skill` command on PATH. Only `surf` and
`surf-plan-skill` symlinks were created. Calling `surf-search-skill …`
produced `command not found`, breaking the skill end-to-end.

### Root cause

The v4.0.0 rename moved `bin/surf-skill.mjs` → `bin/surf-search-skill.mjs`
(file rename) but `package.json#bin` was missed — it still mapped
`"surf-skill": "./bin/surf-skill.mjs"`, pointing at a file that no longer
exists. npm silently skipped the broken bin entry instead of erroring,
so no `surf-search-skill` symlink was ever created.

### Fix

- `package.json#bin`: `"surf-skill": "./bin/surf-skill.mjs"` →
  `"surf-search-skill": "./bin/surf-search-skill.mjs"`.

### Files changed

- `package.json` (bin entry + version bump).
- `bin/{surf,surf-search-skill,surf-plan-skill}.mjs` — `VERSION` →
  `4.0.1`.
- `src/install/postinstall.mjs` — banner string.
- `SKILL.md`, `skills/surf-plan-skill/SKILL.md` — frontmatter
  `version: "4.0.1"`.
- `README.md` — Status badge and Repository layout heading.

### Upgrading

```bash
npm i -g surf-agent-skill@latest
surf-search-skill --version   # 4.0.1
```

No other behavior changes — this is purely a packaging fix.

## v4.0.0 — rename `surf-skill` skill → `surf-search-skill` (consistent suffix), audit cleanup

### Why a major bump

In v3.0.0/v3.0.1 (GitHub-only experiments), we shipped a 2-skill bundle
named `surf-skill` (search) + `surf-plan-skill` (planning). That naming
was asymmetric — the search skill was missing the `-skill` suffix while
the planning skill had it. v4.0.0 makes both consistent:

- **Skill name `surf-skill` → `surf-search-skill`** (frontmatter, harness
  symlinks, all docs).
- **Bin `surf-skill` → `surf-search-skill`** (renamed; old bin removed —
  scripts that called `surf-skill ...` need to update).

The **npm package name stays `surf-agent-skill`** (it's the bundle name; the
two skills + 3 bins live inside it). So `npm i -g surf-agent-skill` continues
to install the package, just exposing different binaries inside.

### Breaking changes for v2.x users

- Scripts that ran `surf-skill <subcommand>` must now run
  `surf-search-skill <subcommand>`. Example:
  ```bash
  # before (v2.x)
  surf-skill search "claude api"

  # after (v4.0.0)
  surf-search-skill search "claude api"
  # OR use the wrapper (NEW in v3+):
  surf search                            # interactive setup
  ```
- The harness symlink `~/.claude/skills/surf-skill` is now
  `~/.claude/skills/surf-search-skill`. Postinstall removes the old
  symlink (it's in `LEGACY_NAMES` cleanup) and creates the new one.
- Agent prompts that referenced "surf-skill" by name should now say
  "surf-search-skill" — this is mainly docs/instructions, since the
  agent discovers skills by what's in `~/.claude/skills/`.

### What's new vs v3.0.1

- All `surf-skill` references in skill names, CLI commands, banners,
  HELP text, error messages, postinstall output, and docs updated to
  `surf-search-skill`. npm package name + URLs + library imports remain
  `surf-agent-skill` (correct — that's the npm distribution unit).
- `harness-install.mjs::SKILLS` array now lists `surf-search-skill` as
  the search skill (was `surf-skill`).
- `harness-install.mjs::LEGACY_NAMES` adds `surf-skill` and `surf-plan`
  so upgrades from v2/v3 cleanly remove old symlinks before creating new
  ones.
- `references/plan-workflow.md`, `src/plan/plan-file.mjs`,
  `src/lib/project-config.mjs`, `src/lib/format.mjs`, `src/lib/keys-cmd.mjs`
  all updated.

### Audit fixes (bugs caught while renaming)

- v3.0.0/v3.0.1 had several stale `surf-plan` (bare, no `-skill` suffix)
  refs in `src/plan/plan-file.mjs:154` (docstring) and
  `references/plan-workflow.md` (section headers) — leftover from the
  standalone v1.0.0 migration. Fixed.
- The v3.0.0 `src/install/postinstall.mjs` banner hardcoded `3.0.0` —
  now reads correctly (and updated to 4.0.0).
- The v3.0.0 `bin/surf-plan-skill.mjs` HELP title was `surf-plan-skill-skill`
  from an over-aggressive sed during the v2→v3 migration. Fixed.
- `package.json` `test:syntax` script referenced the old `bin/surf-skill.mjs`
  filename — updated to `bin/surf-search-skill.mjs` so CI/local tests pass.

### Files changed (high-level)

- Renamed: `bin/surf-skill.mjs` → `bin/surf-search-skill.mjs` (git rename).
- Edited: `SKILL.md`, `skills/surf-plan-skill/SKILL.md`, all bins,
  `package.json`, `README.md`, `CHANGELOG.md`,
  `src/lib/{harness-install,check-surf-skill,keys-cmd,project-config,format}.mjs`,
  `src/install/postinstall.mjs`, `src/index.mjs`, `src/plan/plan-file.mjs`,
  `references/plan-workflow.md`.
- Internal `VERSION` constants in all bins, `dispatch.mjs`, and
  `validators/index.mjs` bumped to `4.0.0`.

### What didn't change

- npm package name: still `surf-agent-skill`.
- npm package install: still `npm i -g surf-agent-skill`.
- Library imports: still `import { search } from 'surf-agent-skill'`.
- Provider adapter behavior, dispatch fallback, validator logic,
  keys.json schema, plan-file format, harness directories — all
  unchanged from v3.0.1.
- The `surf-plan-skill` skill name stays as is (was already correct).

### Migration

```bash
# Upgrade:
npm i -g surf-agent-skill@latest

# Verify all 3 bins:
surf --version              # 4.0.0
surf-search-skill --version # 4.0.0
surf-plan-skill --version   # 4.0.0

# Check the new symlinks (and old ones removed):
ls ~/.claude/skills/        # surf-search-skill + surf-plan-skill (NO surf-skill)
ls ~/.agents/skills/        # same
```

Find/replace in your scripts: `surf-skill ` → `surf-search-skill ` (mind
the trailing space so you don't break `npm i -g surf-agent-skill`).

---

## v3.0.1 — package.json fix for the v3.0.0 bundle

v3.0.0 shipped to GitHub with a partial `package.json` edit: the new
`surf` and `surf-plan-skill` `bin` entries were missing, the `version`
field wasn't bumped (still `2.1.1`), and the description didn't mention
the planning skill. The skill code itself was fine, but `npm i -g
surf-agent-skill@3.0.0` would only install the `surf-skill` binary, hiding the
new `surf` wrapper and `surf-plan-skill` CLI. v3.0.1 corrects the
manifest so the bundle actually exposes all 3 bins on install.

What changed in v3.0.1 vs v3.0.0:

- `package.json::version` 2.1.1 → 3.0.1
- `package.json::bin` includes all 3: `surf`, `surf-skill`, `surf-plan-skill`
- `package.json::description` updated to describe the bundle (2 skills)
- `package.json::exports` adds `./plan` and `./validators` subpath exports
- `SKILL.md::metadata.version` 2.1.1 → 3.0.1
- All internal `VERSION` constants bumped to 3.0.1

No code-behavior changes vs v3.0.0; release v3.0.0 is superseded.

If you installed v3.0.0 by hand from GitHub: upgrade with
`npm i -g surf-agent-skill@latest` and `surf doctor` to confirm all 3 bins
are present.

---

## v3.0.0 — multi-skill bundle: surf-skill + surf-plan-skill + `surf` wrapper with live key validation

### What's new

This release reshapes the package from one skill into **two skills + a
top-level setup wrapper**, all installed by `npm i -g surf-agent-skill`.

**New skill: `surf-plan-skill`** — research-driven execution planning
that follows a strict 6-phase workflow (preflight → project discovery →
baseline web research → conversation → clarifying questions each backed
by search → synthesis search → write Markdown plan with `[^N]` cited
footnotes). Triggers on "make a plan", "design X", "architect Y", etc.
Plans land in `~/.claude/plans/` (or `./plans/` if it exists).

**New CLI: `surf`** — the friendliest entry point. Interactive setup
wizard that:
- Detects both skills in all 4 harness skill dirs.
- Lists configured keys per provider (masked).
- **Validates every key against its provider's real API before saving**
  (1-credit cost, 1-3s per key). Invalid keys are dropped with a clear
  error; valid keys are saved.
- Re-validates existing keys on demand.

**Validation is now mandatory at every key-add path**:
- `surf` interactive add: live-validates before saving.
- `surf-skill setup`: validates each freshly-collected key in the wizard
  batch; drops invalid; reports a summary.
- `surf-skill keys add --provider X <key>`: validates before saving.
  Opt out with `--skip-validate` (for known-good or offline scenarios).

### Bins shipped (3)

- `surf` — interactive setup + key validation (new)
- `surf-skill` — search engine (unchanged surface; 3.0.0 internal)
- `surf-plan-skill` — planning skill CLI (list/show/new/doctor)

### Package layout

```
surf-skill/
├── bin/{surf,surf-skill,surf-plan-skill}.mjs
├── SKILL.md                        # surf-skill skill (root)
├── skills/surf-plan-skill/SKILL.md # surf-plan-skill (planning)
├── src/
│   ├── index.mjs                   # library entry (search + extract + ...)
│   ├── plan/                       # plan-file, plans-dir, slug
│   ├── validators/                 # per-provider key validators
│   ├── lib/                        # adapters, dispatch, state, cost, ...
│   └── install/                    # postinstall + preuninstall
└── references/
```

### Postinstall (cross-OS)

Each of the 4 supported harness skill dirs now gets **2 symlinks**:

- `<harness>/surf-skill`      → package root (search skill)
- `<harness>/surf-plan-skill` → `skills/surf-plan-skill/` (planning skill)

Harnesses: `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`,
`~/.pi/agent/skills`. Symlink on POSIX + Windows-with-Developer-Mode;
falls back to recursive copy on Windows without it.

Existing v2.x users: the surf-skill symlink still points at package root
(unchanged); the new surf-plan-skill symlink is added.

### Migration from v2.x

```bash
npm i -g surf-agent-skill           # picks up v3.0.0
surf doctor                   # confirm both skills + keys
surf                          # interactive — add more keys if needed
```

Your existing `~/.config/surf/keys.json` is preserved. CLI commands
that worked in v2.x still work in v3.0.0 (no breaking flag changes;
only additive behavior: validation defaults on for `keys add`, opt out
with `--skip-validate` if needed).

### Migration from the standalone `surf-plan` v1.0.0 (now retired)

The standalone `frederico-kluser/surf-plan` repo and the unpublished
`surf-plan` npm name are retired. Use `npm i -g surf-agent-skill` — it bundles
the planning skill as `surf-plan-skill`. The SKILL.md frontmatter name
changed from `surf-plan` → `surf-plan-skill`.

---

## v2.1.1 — Robust key rotation: Brave 422 now burns the key

### Bug

When a Brave key was malformed (wrong length/charset), the API returns
HTTP **422** rather than 401. v2.1.0 classified 422 as `caller_4xx`, which
made dispatch throw without burning the key or trying the next one. That
violated the cross-provider fallback contract: a single bad-format key
could short-circuit the chain instead of rotating.

### Fix

`src/lib/providers/brave.mjs::mapError` now classifies 422 as `auth`
(burn key, rotate). The trade-off:

- **Real malformed token** → burns the key, dispatch tries the next key
  (or next provider if `--provider` not set). The user gets a result.
- **Genuinely bad query param** → all keys fail with 422; surfaces as
  `AllProvidersExhausted` with a hint, still actionable.

### Verified

Re-ran the 3 fallback tests with v2.1.1:

- T1 same-provider rotation (tavily key #0 bad → key #1 succeeds): ✓
- T2 cross-provider fallback (tavily/parallel both 401 → brave 200): ✓
- T3 all keys bad incl. malformed Brave: **now burns Brave key + reports
  AllProvidersExhausted** (instead of throwing on the 422)

### Also fixed

- `src/lib/dispatch.mjs::VERSION` was stuck at `1.0.0` since the initial
  release; bumped to `2.1.1` so the `X-Client-Name` header surfaces
  the correct CLI version to providers.
- `SKILL.md::metadata.version` was missed in the v2.1.0 bump (still
  showed `2.0.0`); now `2.1.1`.

No breaking changes.

---

## v2.1.0 — Brave Search as 3rd provider + `--mode` flag

### What's new

- **Brave Search added as 3rd provider** (`--provider brave`). Brave runs
  its own index (independent from Google/Bing) and currently offers $5/mo
  in API credit + metered usage (~$0.003/query) after the free tier was
  retired in Feb 2026. Search only — Brave has no extract/crawl/map/
  research equivalents, so the capability map keeps those Tavily-only.
- **New `--mode <fast|normal|slow>` flag** for `search`. Each provider
  translates the mode to its native tier:

  | Mode | Tavily | Parallel | Brave |
  |---|---|---|---|
  | `fast`   | `search_depth=fast` | (ignored) | `count=5` |
  | `normal` | `search_depth=basic` | `/v1/search` | `count=10` |
  | `slow`   | `search_depth=advanced` | (ignored) | `count=20` |

  `--depth basic|advanced` continues to work as a legacy alias for Tavily.

- **Library API gets `opts.mode`, `opts.braveKey`, `opts.braveKeys`**:
  ```js
  await search('claude api', { mode: 'fast', braveKey: 'BS...' });
  ```

- **`BRAVE_API_KEY` / `BRAVE_API_KEYS` env vars** now part of the discovery
  hierarchy (env > .env > ~/.config/surf/keys.json).

- **Setup wizard** now prompts for Brave keys after Tavily + Parallel.

- **State migration is transparent**: existing `~/.config/surf/keys.json`
  files from v2.0.x get a `brave` section added automatically on next
  `loadState()` — no manual upgrade step needed.

### Default chain order

`search` chain is now `[tavily, parallel, brave]`. Existing users see no
behavior change (Tavily still tried first); Brave is the 3rd fallback.
`last_ok_provider` still wins.

### Breaking changes

None. CLI and library APIs are backward compatible.

### Files added

- `src/lib/providers/brave.mjs` — adapter, `mapError()`, `/web/search`
  with mode → count translation.

### Files modified

- `src/lib/providers/index.mjs` — register brave + add to capabilityMap.search
- `src/lib/state.mjs` — `PROVIDERS = ['tavily', 'parallel', 'brave']` +
  `normalizeFullState()` for graceful schema migration
- `src/env.mjs` — `discoverKeys()` returns `{ tavily, parallel, brave }`
- `src/lib/cost.mjs` — `estimateBrave()` returns 1 credit/search
- `src/lib/setup.mjs` — 3-provider wizard
- `src/lib/providers/tavily.mjs` — mode → search_depth resolution
- `src/lib/api/search.mjs` — library opts.mode
- `bin/surf-skill.mjs` — HELP + `--mode` flag wiring
- `src/lib/harness-install.mjs` — skeleton with brave section
- `package.json`, `SKILL.md`, `README.md` — bump 2.0.0 → 2.1.0, doc updates

### Fora de escopo

- Brave `/summarizer/search` endpoint — defer to v2.2 (different rate
  limit, response shape adds `data.answer`).
- Brave Goggles support (`--goggle <id>`) — defer.
- News / Images / Videos / Local / Spellcheck endpoints — defer.

---

## v2.0.0 — npm package, cross-OS install, library mode

### What's new

- **One-liner cross-OS install via npm.** `npm i -g surf-agent-skill` works on
  Linux, macOS, and Windows. Postinstall script creates symlinks into all
  4 supported agent harnesses (Claude Code, OpenCode, Codex CLI, Pi
  Coding Agent), initializes `~/.config/surf/keys.json`, and cleans up
  legacy symlinks from prior versions. Falls back to recursive copy on
  Windows without Developer Mode.
- **Library mode for Node / Next.js / Express.** Import named functions:
  ```js
  import { search, extract, research } from 'surf-agent-skill';
  const r = await search('claude api', { max: 3 });
  ```
  Auto-discovers keys from `opts → process.env → .env → ~/.config/surf/keys.json`
  (each level can contribute; results merged + deduped).
- **Multi-key wizard.** `surf-skill setup` now prompts for N keys per
  provider (Enter empty to finish that provider). Add 1+ Tavily + 1+
  Parallel keys in one pass.
- **Auto-wizard on first TTY use.** Running any command that needs keys
  in a TTY with empty config auto-launches the wizard, then resumes the
  command. CI/non-TTY behavior unchanged (clear actionable error).
- **Batch search in the library too.** `search(['q1', 'q2', 'q3'], opts)`
  returns `{ summary, data: { batches } }` — same shape as CLI batch.

### Breaking changes

- **Distribution moved from `git clone + install.sh` to `npm i -g`.**
  If you installed via the old `install.sh`:
  ```bash
  # Remove old install
  rm -f ~/.local/bin/surf-skill
  rm -rf ~/.agents/skills/surf-skill ~/.claude/skills/surf-skill \
         ~/.codex/skills/surf-skill ~/.pi/agent/skills/surf-skill
  # Install via npm
  npm i -g surf-agent-skill
  # Your ~/.config/surf/keys.json is preserved.
  surf-skill keys list
  ```
- **Repo layout**: `skills/surf-skill/*` moved to root. The package now
  lives directly at the repo root for npm publishing. The `install.sh`
  script is gone (replaced by `src/install/postinstall.mjs`).
- **Package name** unchanged (`surf-agent-skill`).
- **CLI surface unchanged** — all commands, flags, and behavior identical.
- **State location unchanged** — `~/.config/surf/keys.json` and
  `~/.cache/surf/` preserved.

### Files added

- `src/index.mjs` — library entry (named exports)
- `src/env.mjs` — key discovery hierarchy + dotenv loader
- `src/install/postinstall.mjs` — cross-OS postinstall (idempotent)
- `src/install/preuninstall.mjs` — clean up symlinks on `npm rm`
- `src/lib/harness-install.mjs` — `symlinkOrCopy` helper, legacy cleanup
- `src/lib/api/{search,extract,crawl,map,research}.mjs` — library wrappers

### Files modified

- `package.json` — `type: module`, `bin`, `main`, `exports`, `files`,
  `postinstall`/`preuninstall` scripts; version 1.0.0 → 2.0.0
- `bin/surf-skill.mjs` — imports point to `../src/lib/`; VERSION 2.0.0;
  auto-wizard block on first TTY use
- `src/lib/setup.mjs` — multi-key loop (N keys per provider)
- `src/lib/dispatch.mjs` — accepts `runCtx.state` for in-memory library mode
- `README.md` — one-liner install, library section, bonus features
- `SKILL.md` — `metadata.version: "2.0.0"`, npm install in requires

### Files removed

- `skills/surf-skill/install.sh` — replaced by postinstall.mjs
- `skills/` directory — dissolved into root (npm-friendly layout)
- All `CHANGELOG-v2.x.md` (consolidated into this CHANGELOG.md in v1.0.0)

---

## v1.0.0 — Initial release

`surf-skill` is a multi-provider web skill for AI coding agents that fronts
**Tavily** and **Parallel AI** behind a single bash CLI. The agent calling
this skill never picks the provider — `surf-skill` does, with automatic
key rotation, provider fallback, and last-known-good persistence.

### Capabilities

| Operation | Tavily | Parallel | Default order |
|---|---|---|---|
| `search` | ✓ | ✓ | tavily → parallel |
| `extract` | ✓ | ✓ | tavily → parallel |
| `crawl` | ✓ | ✗ | tavily only |
| `map` | ✓ | ✗ | tavily only |
| `research-start` / `research` | ✓ | ✓ | parallel → tavily |
| `research-poll` | by `request_id` prefix | by `request_id` prefix | sticky |

### Features

- **Multi-provider fallback.** Tavily ↔ Parallel AI by capability map.
- **Multi-key rotation per provider.** Burn on `401/403/402` or persistent
  `5xx`; burned keys auto-reset on the first day of the next calendar month.
- **Provider chain memory.** `last_ok_provider` persisted in
  `~/.config/surf/keys.json` so the next call starts on the hot path.
- **`--provider <tavily|parallel>`** forces a specific provider (disables
  fallback for that call). `--no-fallback` pins to the default provider.
- **Batch search.** Pass multiple positional args to `search` and each is
  an independent query, run sequentially, with partial failures reported
  inline.
- **Progress logs to stderr.** One self-contained line per event
  (`[surf HH:MM:SS] ▸/✓/✗/↻/⚠/⏱`). Stable format for agent parsing.
  Stdout stays clean for JSON/Markdown. `--quiet` / `SURF_QUIET=1`
  silences.
- **Interactive onboarding.** `surf-skill setup` (TTY) wizard prompts for
  keys and persists to `~/.config/surf/keys.json` (chmod 600). On error,
  TTY users see `→ Run 'surf-skill setup' to configure keys interactively.`
- **Per-project bash-timeout config.** `surf-skill project-config`
  auto-detects the harness via `.github/`, `.claude/`, `.pi/` markers and
  writes the right config to raise the bash timeout. Required for GH
  Copilot CLI (default 30 s), recommended for Claude Code / Pi.
- **Self-budget timeout guard.** Reads the harness bash timeout from env
  vars (`BASH_DEFAULT_TIMEOUT_MS`, `PI_BASH_DEFAULT_TIMEOUT_SECONDS`,
  `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`, or `SURF_AGENT_BUDGET_MS`
  override). Aborts early with `LikelyAgentTimeout` instead of being
  killed silently by SIGTERM. Unknown harness → assume 30 s.
- **SIGTERM / SIGINT handler.** Defense in depth: surfaces a
  `KilledBySignal` message with the same `project-config` hint before
  exit 143.
- **Per-project config writer** detects `.github/`, `.claude/`, `.pi/` and
  writes only what the harness in this project needs.
- **Local response cache** (`~/.cache/surf/`, TTL 6 h) keyed by
  `sha256(operation, args)`; `--no-cache` bypasses; cache survives provider
  fallbacks.
- **Local usage ledger** (`~/.cache/surf/usage.jsonl`) per-provider
  breakdown via `surf-skill cost`.
- **Audit log** (`~/.cache/surf/audit.log`) records provider name and key
  INDEX, never the key itself.
- **Cost guard.** Estimates > 10 credits are blocked unless
  `--confirm-expensive` (or `SURF_ALLOW_EXPENSIVE=1`).
- **Predictable JSON.** `--json` returns a normalized envelope with the
  same shape across providers. `--raw-json` exposes the provider response
  for debugging.

### Default behavior

- `search --depth` defaults to `advanced` (better quality, ~3–10 s,
  2 credits). Pass `--depth basic` for the cheaper/faster path.
- `surf-skill research` is capped at 50 s and refuses `--model pro`/`ultra`
  (use `research-start` + `research-poll` for those).

### Provider notes (verified 2026-05-20 against live APIs)

- **Tavily** `POST /search`: `Authorization: Bearer <key>`. Body accepts
  `query`, `search_depth`, `max_results`, `topic`, `time_range`,
  `include_domains`, `exclude_domains`, `country`, `include_answer`,
  `include_raw_content`, etc.
- **Parallel AI** `POST /v1/search`: `x-api-key: <key>`. Body accepts
  ONLY `{ objective, search_queries }`. Any other field (e.g. `processor`,
  `max_results`) is rejected with `Extra inputs are not permitted`.
  Tavily-only knobs are silently ignored when the call lands on Parallel.
- **Parallel** has no crawl / no URL map / no public usage endpoint.

### Supported harnesses

| Harness | Default bash | Max | Coverage after install |
|---|---|---|---|
| **Claude Code** | 120 s | 600 s (hard) | 300 s default via `~/.claude/settings.json` |
| **Pi Coding Agent** | 120 s | 600 s | 300 s default via `~/.pi/agent/settings.json` |
| **GH Copilot CLI** | **30 s** | not documented | per-project `.github/copilot-hooks.json` (run `surf-skill project-config`) |
| **OpenCode** | varies | 600 s | 600 s default via `~/.config/opencode/opencode.json` |
| **Codex CLI** | n/a | n/a | symlinked under `~/.codex/skills/surf-skill/` |

### Stack

Node ≥ 18, bash, **zero npm dependencies**. The full CLI is under 500 LOC
in `skills/surf-skill/bin/surf-skill.mjs` + `skills/surf-skill/lib/*.mjs`.
