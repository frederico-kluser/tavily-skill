# Credit cost reference

`surf` uses **Tavily credits** as its single unit. Parallel AI's per-call
pricing is not published, so the Parallel column below is a coarse estimate
that only powers the `--confirm-expensive` gate (>10 credits ⇒ blocked).

## Tavily — published

Pay-as-you-go: **US$ 0.008 / credit**. Free tier: **1,000 credits / month**.

| Plan | US$ / mo | Credits / mo |
|---|---|---|
| Researcher (Free) | 0 | 1,000 |
| Project | 30 | 4,000 |
| Bootstrap | 100 | 15,000 |
| Startup | 220 | 38,000 |
| Pro | 500 | 100,000 |
| Enterprise | custom | custom |

Per-call costs:

| Endpoint | Credits |
|---|---|
| `/search` basic / fast / ultra-fast | 1 |
| `/search` advanced or `auto_parameters=true` | 2 |
| `/extract` basic | 1 per 5 URLs |
| `/extract` advanced | 2 per 5 URLs |
| `/map` no instructions | 1 per 10 pages |
| `/map` with instructions | 2 per 10 pages |
| `/crawl` basic | `ceilDiv(limit, 10) * mapRate + ceilDiv(limit, 5) * extractRate` (mapRate=1, extractRate=1) |
| `/crawl` advanced | `ceilDiv(limit, 10) * mapRate + ceilDiv(limit, 5) * extractRate` (mapRate=2, extractRate=2) |
| `/research` mini | dynamic, ~5–15 |
| `/research` pro | dynamic, ~15–50 |
| `/research/{id}` (poll) | 0 |
| `/usage` | 0 |

## Parallel AI — estimated

Public pricing is opaque. The values below come from the relative tiering of
the processor model (`lite < base < core < pro < ultra < ultra8x`) and are
used only by `lib/cost.mjs` to gate expensive calls.

| Operation | Estimated "credits" |
|---|---|
| `search` (lite processor) | 1 |
| `search` (base processor — set by `--depth advanced`) | 2 |
| `extract` (any) | 1 per 5 URLs |
| `tasks/runs` lite (`--model mini` / `--processor lite`) | 1 |
| `tasks/runs` base (`--model auto` / `--processor base`) | 2 |
| `tasks/runs` core (`--processor core`) | 5 |
| `tasks/runs` core2x (`--processor core2x`) | 8 |
| `tasks/runs` pro (`--model pro` / `--processor pro`) | 8 |
| `tasks/runs` ultra (`--model ultra` / `--processor ultra`) | 25 |
| `tasks/runs` ultra2x (`--processor ultra2x`) | 50 |
| `tasks/runs` ultra4x (`--processor ultra4x`) | 100 |
| `tasks/runs` ultra8x (`--processor ultra8x`) | 200 |
| `crawl`, `map` | n/a (not supported) |

Every tier also has a `-fast` variant (e.g. `pro-fast`) — same estimated
credit cost, 2-5x lower latency, optimized for speed over absolute
freshness. See `references/parallel-api.md` for the full latency/use-case
table and when to reach for each tier.

## surf-free-agent-skill (wikipedia, ddg) — free, keyless

The separate **`surf-free-agent-skill`** answers `search` with two **free, no-API-key**
providers (it does NOT share surf-research-agent-skill's paid chain). Both are
estimated at **0 credits** by `lib/cost.mjs`.

| Provider | Cost | Returns |
|---|---|---|
| `wikipedia` (MediaWiki search) | 0 | broad encyclopedic full-text hits + snippets |
| `ddg` (DuckDuckGo Instant Answer) | 0 | instant answers / entities (blank for most phrases) |

Use `surf-free-skill "query"` for free lookups with zero setup.
`surf-research-agent-skill` itself requires a key (Tavily / Parallel / Brave).

## Rules of thumb

- **Default to `--depth basic` and `--max 5`.** Escalating to `advanced`
  doubles cost on both providers.
- **Always prefer `map` before `crawl`** when scoping a site — `map` returns
  URLs cheaply, and you can re-run `crawl` on a filtered subset. Both are
  Tavily-only operations.
- **`auto_parameters` always costs 2 Tavily credits**, even if it picks
  `basic` internally.
- **`research --model pro` / `--processor ultra`** can be very expensive
  — always confirm with the user.
- **Cache (TTL 6 h)** makes repeated identical queries free. Use
  `--no-cache` only when freshness matters.
- **`research-poll` is free** — poll every 10–15 s without budget impact.
- **`--confirm-expensive` uses the WORST estimate across the eligible
  providers**, so a search routed to either Tavily or Parallel will be
  gated by the higher of the two estimates.
