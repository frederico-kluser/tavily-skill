# Changelog

> **Historical entries (v1.0.0 – v4.1.0)** have been archived to [CHANGELOG-archive.md](CHANGELOG-archive.md).

## 8.0.1 — `keys list --json` no longer prints raw API keys

**Security fix.** `surf-research-skill keys list --json` dumped every stored key
in plaintext. The human-readable listing has always masked them; the JSON form
silently did not.

That asymmetry matters more here than in a normal CLI: this package exists to be
driven by AI agents, and agent stdout lands in transcripts, handoff files and
task plans that then get read back, committed, or pasted into a chat. One
`keys list --json` in a logged command was a complete key exfiltration path, and
nothing in the output warned you.

`--json` now masks (`BSAlm…ulEo`) and adds `key_count`. The burn, cooldown and
validation fields are unchanged, so `check-surf-skill.mjs` and anything else
reading the state shape keeps working. Pass `--unsafe-show-keys` to opt back in
to raw values — the flag is deliberately named to be uncomfortable in a script.

Found while auditing a downstream skill that was about to call this command and
write its output to disk.

## 8.0.0 — Brave only, and it says so when it cannot

**Breaking.** surf now searches with Brave and nothing else. If it cannot
identify a valid Brave key it stops with **exit 78** before doing any work,
instead of quietly answering from somewhere cheaper.

### Why

v7 fanned out across Tavily, Parallel and Brave, and when every paid key was
exhausted `surf-ai` dropped to a free Wikipedia/DuckDuckGo tier and returned a
confident, cited-looking answer at exit 0. Nothing in the output distinguished
that from a real research answer. The providers were kept apart by comments
rather than by structure, and the comments did not hold.

### Removed

- **Tavily, Parallel, Wikipedia and DuckDuckGo adapters.** Deleted, not
  disabled. There is now no code path that can answer a search without a Brave
  key, which is what makes the hard stop unfakeable.
- **`surf-free-skill` and `surf-free-agent-skill`.** The keyless product is
  gone, and its symlink is removed from every harness dir on upgrade.
- **`extract`, `crawl`, `map`, `research`, `research-start`, `research-poll`,
  `usage`.** Brave's `/web/search` returns ranked links and snippets, never page
  content, and has no crawl, site-map or async-research endpoint. These verbs
  had no honest implementation, so they exit 2 with an explanation rather than
  an "unknown command". The library exports throw `RemovedInV8` instead of
  vanishing, so a downstream import does not become a `SyntaxError`.
- `--provider` now accepts only `brave`; `--no-fallback` is gone (nothing to
  fall back from).

**Your Tavily and Parallel keys are not destroyed.** On first run they are
copied to `~/.config/surf/keys.legacy-<date>.json` (chmod 600) and a warning
names the file.

### The key gate (`src/lib/preflight.mjs`)

Every bin, and `dispatch()` itself, resolves the gate before doing work:

| Verdict | Code | Fix |
|---|---|---|
| no key anywhere | `BraveKeyMissing` | `keys add --provider brave <key>` |
| every key burned | `BraveKeyBurned` | `keys reset --provider brave` |
| every key rate-limited | `BraveKeyCooling` | wait, or add a second key |
| the key was rejected | `BraveKeyInvalid` | replace it |

All four exit **78** (`EX_CONFIG`) — deliberately distinct from 1 (the
operation ran and failed) and 2 (bad usage), so an orchestrating agent can tell
"your configuration is broken" from "the search failed" without parsing prose.

**Validation is free**, which is what makes a per-invocation gate affordable: a
Brave request with no `q` is rejected before it is billed, and a good key and a
bad key are told apart by `error.code`, not by HTTP status. Verified with an A/B
of 108 deliberately-failing requests — monthly quota moved by zero. The verdict
is cached in `keys.json` (`validated`, TTL 7 days) so the common path is offline.

### Fixed — the search modes

- **A non-numeric `--max` no longer burns every key.** `clamp(NaN,1,20)` is
  `NaN`, and `NaN` reached the wire as the literal string `count=NaN`, which
  Brave answers with 422 — which v7 classified as `auth` and used to burn each
  key in turn, permanently. Numeric inputs are now floored, clamped and
  finite-checked, and non-finite values can no longer be serialised at all.
- **422 is no longer read as "bad key".** Brave answers an invalid token *and*
  an invalid parameter with 422. They are now told apart by `error.code`:
  `SUBSCRIPTION_TOKEN_INVALID` burns the key; `VALIDATION` is a caller error;
  `OPTION_NOT_IN_PLAN` (HTTP 400) is a plan limitation. Note the trap that made
  this subtle: `OPTION_NOT_IN_PLAN` also carries
  `meta.component: "authentication"`, so branching on that field would burn a
  perfectly good key.
- **`--search-mode` now actually changes the request.** In the surf-ai path a
  defaulted `max` was always present and always won, so `fast`, `normal` and
  `slow` produced byte-identical Brave calls. `max` is now sent only when the
  user actually asked for a result count.
- **No more phantom `depth: 'advanced'` default.** With no `--mode`, v7 silently
  ran every search at the widest tier while `--help` promised `normal`.
- **`--time`, `--start-date`/`--end-date`, `--domains`, `--exclude` and
  `--topic` reach Brave.** They were accepted at the CLI and silently discarded
  by the adapter. `--time` maps to `freshness`, a date range to Brave's
  `YYYY-MM-DDtoYYYY-MM-DD` form, and domains to `site:` operators — OR-grouped,
  because `site:a site:b` is ANDed by Brave and returns nothing.
- **Typos are rejected instead of silently degrading.** `--mode`, `--depth`,
  `--topic`, `--time`, `--safesearch` and `--country` are validated before the
  request. Every unknown argument now produces a warning naming it.
- **`--flag=value` parses.** `--sub-agents=10 "my question"` used to produce the
  flag key `"sub-agents=10"` *and* swallow the question. A valued flag with no
  value is now a usage error rather than boolean `true` — which used to read as
  `Number(true) === 1` and collapse a whole fan-out to one worker.
- **`--mode fast` on `surf-search-normal` is no longer discarded.** Those bins
  fix the run mode, so the validation guard never fired; the tier flag is now
  aliased through with a note, and a contradicting value is an error.

### Fixed — quality of what Brave returns

- `text_decorations=0`: Brave wraps every query-term match in `<strong>`, and
  that markup was piped verbatim into markdown output and into LLM prompts.
- `extra_snippets`: up to five more excerpts per result, appended to the
  content. Plan-gated, and **silently absent** when unavailable — treated as a
  plan signal, never an error.
- `published_date` is now `page_age` (ISO-8601). v7 used `age`, a display string
  like "2 days ago", feeding a prompt that explicitly demands date rigour. The
  human string survives as `age_text` for human-facing output only.
- The dead `answer` field is gone. It read `data.summarizer.summary` from a
  plain `/web/search` response, where the summarizer block never appears.
- `more_results_available` is surfaced, and an **absent** value reads as false —
  Brave omits the field when results are exhausted rather than setting it false.

### Added — rate limiting (`src/lib/ratelimit.mjs`)

Brave enforces a 1-second sliding window counted **on arrival**, with no
`Retry-After` header. The allowance is per plan and varies by two orders of
magnitude: the 2026 Search plan is 50 req/s, a grandfathered key is **1**.

surf now **learns** the real limit from `x-ratelimit-policy` (and from the 429
body, which carries the whole plan inline) and paces requests through a token
bucket held **on disk** — because the sub-agents of `surf-research-agent-skill`
are separate OS processes, and an in-process semaphore would let ten of them
each fire N requests in the same second.

Asking for more simultaneity than the plan serves does not fail; it queues, and
surf warns with the arithmetic. Adding a second Brave key is the real fix —
each key carries its own per-second budget.

### Added — the deepening algorithm (`src/lib/ai/frontier.mjs`)

v7's loop was flat: plan N queries, run them, ask for N more. Nothing recorded
why a query existed or what it descended from, so depth was indistinguishable
from repetition.

v8 runs a **priority frontier over a tree**. Every query is a node with a
parent, a depth and a kind (`breadth` / `depth` / `verify`), so the loop can
reason about a branch instead of a list:

- a **per-branch quota**, so one hot sub-question cannot consume a whole wave;
- a **verification reserve**, so falsifying a contested claim outranks widening;
- **deterministic admission** — duplicates, over-deep nodes and closed branches
  are rejected in plain code, and every rejection is *recorded*, because a
  forgotten rejection gets re-proposed every round and the loop never converges;
- **automatic branch closure** after two waves with no new sources;
- dedup that keeps version numbers distinct, so "gpt 4 pricing" and
  "gpt 5 pricing" are not collapsed into one query.

`--ledger` prints the coverage table with depth and parent columns, plus every
candidate the frontier refused and why.

### Added — `--sub-agents N` (default 10, max 20)

One number for simultaneity, at both levels:

- in the CLI it is the wave width **and** the worker-pool width, so the two can
  never multiply;
- in `surf-research-agent-skill` it is the burst size, and a firing orchestrator
  passes `--sub-agents=max(1, floor(N / burst size))` to each sub-agent so the
  two layers **add** instead of multiplying (10 sub-agents × the old default of
  8 would have been 80 concurrent requests).

`--sub-agents=N` and `--sub-agents N` both work. `--concurrency` remains as a
deprecated alias that loses to `--sub-agents`.

### Other

- `keys list` shows the validation verdict per key. `keys reset` also clears
  failed verdicts and cooldowns, so a reset really does re-test the key.
- `keys remove` re-indexes `cooldowns` and `validated` alongside `burned`;
  leaving them unshifted attributed one key's verdict to another.
- `buildInMemoryState` carries burn/cooldown/validation state over from
  `keys.json`, matching on key **value** rather than index. Library callers used
  to re-use keys the CLI had already proved dead.
- `NoProviderAvailable` no longer prescribes `keys add` when the real fix is
  `keys reset`; one `explainUnusable()` now drives every message.
- `surf doctor` asks the gate instead of counting keys. It used to report
  "brave 1 key(s), 1 burned" and exit 0 — the exact state in which every command
  fails.
- New `references/brave-api.md`; `references/tavily-api.md` and
  `references/parallel-api.md` deleted; `references/COSTS.md` rewritten around
  requests-per-second rather than credits.
- `SKILL.md` closed `</orchestrator>` twice, so the XML handed to the model was
  malformed. Fixed.
- New `test/brave.mjs` — 137 assertions covering the adapter, the flag parser,
  the frontier and the gate. Every one corresponds to a defect that was live in
  v7. `test/smoke.mjs` now stubs Brave (GET + query params) instead of Tavily
  (POST + JSON body).

### Upgrading

1. `npm i -g surf-agent-skill@8`
2. `surf-research-skill keys add --provider brave <key>` (or `surf`)
3. Replace `--concurrency N` with `--sub-agents=N`.
4. Replace any use of `extract`/`crawl`/`map`/`research*` with `search` plus
   your own fetch.
5. Expect **78**, not 1, when the key is the problem.

---

## v7.0.0 — documentação alinhada, débitos resolvidos

### Changed

- **Versão alinhada** em todos os artefatos (package.json, bins, src, skills, README).
  SKILL.md principal migrou para arquitetura de orquestrador autônomo multi-agente
  com rajadas de dúvidas (v7.0.0).
- **src/lib/ai/orchestrator.mjs** agora declara `const VERSION`.
- **CHANGELOG.md** consolidado com entradas para v6.0.0 e v7.0.0.

## v6.0.0 — orquestrador autônomo multi-agente

### Added

- **surf-research-skill transformado em orquestrador autônomo**: o agente principal
  nunca pesquisa — ele levanta dúvidas, dispara rajadas de sub-agentes paralelos,
  e faz triagem das respostas. Dois modos: rajada-única e rajada-contínua.
- **SKILL.md reescrito** como `<orchestrator>` com regras formais (R1-R9),
  registro de dúvidas, roteamento (CALLER/PROJECT/WEB), e portão de admissão.
- **Templates T1-T8** em `references/burst-templates.md` para delegação
  estruturada a sub-agentes.
- **Convergência** por contagem de rajadas secas (k=2), saturação de fontes,
  e teto duro de 12 rajadas.

### Changed

- surf-research-skill passa de toolbox de comandos para orquestrador de
  pesquisa — o loop de pesquisa sai do agente e vai para a skill.

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

