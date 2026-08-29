---
name: project-router
description: Project knowledge map for surf-agent-skill — an autonomous web research tool for AI coding agents. Maps the repo structure, skills, conventions, and key files.
---

# Project Router: surf-agent-skill

## Project Identity

**surf-agent-skill v8.0.0** — an npm package providing an autonomous web research CLI and library for AI coding agents, built on **Brave Search and nothing else**.

- **Type**: npm package (`surf-agent-skill`)
- **License**: MIT
- **Runtime**: Node.js >= 18
- **Module system**: ESM (`.mjs` extension)
- **Dependencies**: Zero npm runtime dependencies
- **Description**: Brave-only web research CLI + library. The `surf-ai` orchestrator runs the entire research loop inside the CLI — an LLM plans the queries, up to `--sub-agents` of them execute at once against Brave (paced to the plan's real rate limit, with key rotation), the LLM analyzes remaining gaps, and follow-ups enter a priority frontier as tree nodes so later waves descend into thin branches rather than re-searching wide.
- **Non-negotiable invariant**: there is exactly one search adapter. No valid Brave key means **exit 78** before any work runs. Do not add a second search provider without changing that contract deliberately — the guarantee is structural, and the whole v8 design rests on it.

## Repository Map

| Directory | Purpose |
|---|---|
| `bin/` | 5 CLI entry points: `surf`, `surf-research-skill`, `surf-search-normal`, `surf-search-unlimit`, `surf-plan-skill` |
| `src/lib/ai/` | `surf-ai` orchestrator: plan -> wave -> analyze -> deepen -> synthesize. Contains `orchestrator.mjs`, `frontier.mjs` (the deepening tree), `openrouter.mjs` (LLM), `prompts.mjs`, `cli.mjs`, `render.mjs`, `heuristics.mjs`, `ledger.mjs`, `setup.mjs` |
| `src/lib/providers/` | ONE search adapter: `brave.mjs`, plus `index.mjs` (registry, `capabilityMap.search = ['brave']`) |
| `src/lib/api/` | Library wrappers: `search.mjs` only |
| `src/lib/` | Core modules: `dispatch.mjs` (key rotation + the gate), `preflight.mjs` (the Brave key gate, exit 78), `ratelimit.mjs` (cross-process token bucket), `html.mjs`, `state.mjs`, `cost.mjs`, `cache.mjs`, `audit.mjs`, `flags.mjs`, `pool.mjs`, `progress.mjs`, `setup.mjs`, `format.mjs`, `keys-cmd.mjs`, `project-config.mjs`, `harness-install.mjs`, `check-surf-skill.mjs` |
| `src/install/` | `postinstall.mjs` (cross-OS symlink creation) + `preuninstall.mjs` |
| `src/plan/` | `plan-file.mjs`, `plans-dir.mjs`, `slug.mjs` — research plan file utilities |
| `src/validators/` | `index.mjs` — per-provider API key validators |
| `skills/` | Sub-skills shipped with the package: `surf-plan-agent-skill` |
| `references/` | Documentation: `surf-ai-cli.md` (CLI reference for delegation prompts), `brave-api.md` (what Brave returns and every gotcha), `burst-templates.md`, `failure-modes.md`, `COSTS.md`, `plan-workflow.md` |
| `test/` | `smoke.mjs` (orchestrator, offline) + `brave.mjs` (adapter, flags, frontier, gate) |

## Skills

Skills that agents working **on this project** should know about:

| Skill | File | Purpose |
|---|---|---|
| `surf-research-agent-skill` | `SKILL.md` (root) | Main orchestrator — multi-agent research using bursts of doubt. v8. Two modes: single-burst and continuous-burst. Ceiling of 10 simultaneous sub-agents, tunable with `sub-agents=N` |
| `surf-plan-agent-skill` | `skills/surf-plan-agent-skill/SKILL.md` | Research-grounded execution planning — writes execution plans from research findings |

## Key Files

Every agent working on this project should read these files for context:

| File | Why |
|---|---|
| `package.json` | Version, bin commands, exports map, scripts, npm metadata |
| `SKILL.md` | Main skill definition — the surf-research-agent-skill orchestrator v8 |
| `references/brave-api.md` | Before touching `providers/brave.mjs` or debugging why a flag had no effect |
| `src/lib/preflight.mjs` | The key gate. Every entry point routes through it |
| `README.md` | Comprehensive project documentation, usage, setup |
| `src/index.mjs` | Library entry point — public API surface |
| `references/surf-ai-cli.md` | CLI reference used in delegation prompts to sub-agents |

## Conventions

- **Language**: JavaScript, ESM modules only (`.mjs` extension throughout)
- **No TypeScript** — plain Node.js, no compilation step
- **Zero npm runtime dependencies** — the package ships no `dependencies`, only `devDependencies`
- **Version**: Declared as `const VERSION` in each source file that needs it, plus in `package.json`
- **Provider adapter pattern**: the adapter in `src/lib/providers/` exports `search()`, `validate()`, `mapError()`, and capability declarations. Registered in `index.mjs`. The pattern is retained for clarity, not because a second provider is expected
- **Error classification**: Brave answers a bad key and a bad parameter with the same HTTP 422. Always branch on `error.code`, never on the status — and never on `meta.component`, which reads `"authentication"` for a plan gate on a perfectly good key
- **Exit codes**: 0 ok · 1 the operation ran and failed · 2 usage · **78 configuration (no valid Brave key)** · 143 killed by the harness
- **CLI flag parsing**: CLI bins use `parseFlags()` from `src/lib/flags.mjs`
- **Output discipline**: Progress/logs go to stderr; stdout is clean JSON or Markdown
- **Key storage**: API keys stored in `~/.config/surf/keys.json` (chmod 600). Not stored in environment variables (CLI mode). LLM key via `OPENROUTER_API_KEY` env var or `surf-research-skill ai-setup`
- **Commit convention**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, etc.
- **License**: MIT — every file carries the MIT header

## Architecture Notes

### surf-ai Research Loop

```
orchestrator.mjs --> openrouter.mjs (LLM, via OpenRouter API)
                 --> frontier.mjs  (the deepening tree)
                 --> dispatch.mjs  (gate -> key rotation -> rate limiter)
                      --> brave.mjs
```

The loop: gate -> plan queries -> run a wave of up to `--sub-agents` -> analyze -> admit follow-ups into the frontier as tree nodes -> repeat until resolved / saturated / every branch closed -> synthesize.

### There is no fallback chain

```
search -> brave.   That is the entire chain.
```

The gate (`preflight.mjs`) runs before any search. Without a usable, validated Brave key the process exits 78. This is deliberate: v7's keyless tier meant a research run could answer from Wikipedia and exit 0, and nothing in the output revealed it.

### Rate limiting

Brave enforces a 1-second sliding window counted on arrival, with no `Retry-After`. The per-second allowance is read from `x-ratelimit-policy` (and from the 429 body, which carries the plan inline) and enforced by a token bucket in `~/.cache/surf/ratelimit.json` — **on disk, because sub-agents are separate processes**. Each key has its own budget, so a second key doubles real parallelism.

### Model Fallback Chain

```
deepseek-v4-pro -> deepseek-v4-flash-0731 -> deepseek-v4-flash -> deepseek-v3.2 -> deepseek-chat-v3.1
```

Via OpenRouter. Falls back through models on failure or rate limiting.

### Key Rotation

- **Auth failure (401/403)**: Key is burned (removed from pool)
- **Rate limit (429)**: Key enters cooldown period
- **Auto-reset**: Key pools reset monthly
- **Pool management**: `src/lib/pool.mjs` — multi-key pools per provider
