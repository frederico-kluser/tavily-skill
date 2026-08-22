---
name: project-router
description: Project knowledge map for surf-agent-skill — an autonomous web research tool for AI coding agents. Maps the repo structure, skills, conventions, and key files.
---

# Project Router: surf-agent-skill

## Project Identity

**surf-agent-skill v7.0.0** — an npm package providing an autonomous web research CLI and library for AI coding agents.

- **Type**: npm package (`surf-agent-skill`)
- **License**: MIT
- **Runtime**: Node.js >= 18
- **Module system**: ESM (`.mjs` extension)
- **Dependencies**: Zero npm runtime dependencies
- **Description**: Multi-provider web research CLI + library. The `surf-ai` orchestrator runs the entire research loop inside the CLI — an LLM plans the queries, they execute concurrently across multiple search providers with automatic key rotation and provider fallback, the LLM analyzes remaining gaps, launches more searches, and writes the final cited answer in the shape the calling agent requested.

## Repository Map

| Directory | Purpose |
|---|---|
| `bin/` | 6 CLI entry points: `surf`, `surf-research-skill`, `surf-search-normal`, `surf-search-unlimit`, `surf-plan-skill`, `surf-free-skill` |
| `src/lib/ai/` | `surf-ai` orchestrator: plan -> search -> analyze -> loop -> synthesize. Contains `orchestrator.mjs`, `openrouter.mjs` (LLM), `prompts.mjs`, `cli.mjs`, `render.mjs`, `heuristics.mjs`, `ledger.mjs`, `setup.mjs` |
| `src/lib/providers/` | 5 search providers following an adapter pattern: `tavily.mjs`, `parallel.mjs`, `brave.mjs`, `wikipedia.mjs`, `ddg.mjs`, plus `index.mjs` (provider registry) |
| `src/lib/api/` | Library wrappers: `search.mjs`, `extract.mjs`, `crawl.mjs`, `map.mjs`, `research.mjs` |
| `src/lib/` | Core modules: `dispatch.mjs` (search dispatch), `state.mjs`, `cost.mjs`, `cache.mjs`, `audit.mjs`, `flags.mjs`, `pool.mjs`, `progress.mjs`, `setup.mjs`, `format.mjs`, `keys-cmd.mjs`, `project-config.mjs`, `harness-install.mjs`, `check-surf-skill.mjs` |
| `src/install/` | `postinstall.mjs` (cross-OS symlink creation) + `preuninstall.mjs` |
| `src/plan/` | `plan-file.mjs`, `plans-dir.mjs`, `slug.mjs` — research plan file utilities |
| `src/validators/` | `index.mjs` — per-provider API key validators |
| `skills/` | Sub-skills shipped with the package: `surf-plan-agent-skill`, `surf-free-agent-skill` |
| `references/` | Documentation: `surf-ai-cli.md` (CLI reference for delegation prompts), `burst-templates.md`, `failure-modes.md`, `COSTS.md`, `tavily-api.md`, `parallel-api.md`, `plan-workflow.md` |
| `test/` | `smoke.mjs` — 103 offline assertions |

## Skills

Skills that agents working **on this project** should know about:

| Skill | File | Purpose |
|---|---|---|
| `surf-research-agent-skill` | `SKILL.md` (root) | Main orchestrator — multi-agent research using bursts of doubt. v7. Two modes: single-burst and continuous-burst |
| `surf-plan-agent-skill` | `skills/surf-plan-agent-skill/SKILL.md` | Research-grounded execution planning — writes execution plans from research findings |
| `surf-free-agent-skill` | `skills/surf-free-agent-skill/SKILL.md` | Free keyless search via Wikipedia + DuckDuckGo |

## Key Files

Every agent working on this project should read these files for context:

| File | Why |
|---|---|
| `package.json` | Version, bin commands, exports map, scripts, npm metadata |
| `SKILL.md` | Main skill definition — the surf-research-agent-skill orchestrator v7 |
| `README.md` | Comprehensive project documentation, usage, setup |
| `src/index.mjs` | Library entry point — public API surface |
| `references/surf-ai-cli.md` | CLI reference used in delegation prompts to sub-agents |

## Conventions

- **Language**: JavaScript, ESM modules only (`.mjs` extension throughout)
- **No TypeScript** — plain Node.js, no compilation step
- **Zero npm runtime dependencies** — the package ships no `dependencies`, only `devDependencies`
- **Version**: Declared as `const VERSION` in each source file that needs it, plus in `package.json`
- **Provider adapter pattern**: Each provider in `src/lib/providers/` exports `search()`, `mapError()`, and capability declarations. Registered in `index.mjs`
- **CLI flag parsing**: CLI bins use `parseFlags()` from `src/lib/flags.mjs`
- **Output discipline**: Progress/logs go to stderr; stdout is clean JSON or Markdown
- **Key storage**: API keys stored in `~/.config/surf/keys.json` (chmod 600). Not stored in environment variables (CLI mode). LLM key via `OPENROUTER_API_KEY` env var or `surf-research-skill ai-setup`
- **Commit convention**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, etc.
- **License**: MIT — every file carries the MIT header

## Architecture Notes

### surf-ai Research Loop

```
orchestrator.mjs --> openrouter.mjs (LLM, via OpenRouter API)
                 --> dispatch.mjs (search dispatch)
                      --> provider chain (tavily -> parallel -> brave -> keyless)
```

The loop: plan queries -> dispatch concurrently -> analyze results -> identify gaps -> plan more queries -> repeat until saturation -> synthesize final answer.

### Provider Fallback Chain

```
tavily -> parallel -> brave -> keyless (wikipedia -> ddg)
```

Each provider is tried in order. On failure, the next provider is attempted. Keyless providers (Wikipedia + DDG) always succeed as the final fallback.

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
