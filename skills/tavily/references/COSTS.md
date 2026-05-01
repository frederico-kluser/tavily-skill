# Tavily — credit cost reference (April 2026)

Pay-as-you-go: **US$ 0.008 / credit**. Free tier: **1,000 credits / month**.

## Plans

| Plan | US$ / mo | Credits / mo |
|---|---|---|
| Researcher (Free) | 0 | 1,000 |
| Project | 30 | 4,000 |
| Bootstrap | 100 | 15,000 |
| Startup | 220 | 38,000 |
| Pro | 500 | 100,000 |
| Enterprise | custom | custom |

## Per-call costs

| Endpoint | Credits |
|---|---|
| `/search` basic / fast / ultra-fast | 1 |
| `/search` advanced or `auto_parameters=true` | 2 |
| `/extract` basic | 1 per 5 URLs |
| `/extract` advanced | 2 per 5 URLs |
| `/map` no instructions | 1 per 10 pages |
| `/map` with instructions | 2 per 10 pages |
| `/crawl` basic | mapping + 1/5 pages |
| `/crawl` advanced | mapping + 2/5 pages |
| `/research` mini | dynamic, ~5–15 |
| `/research` pro | dynamic, ~15–50 |
| `/research/{id}` (poll) | 0 |
| `/usage` | 0 |

## Rules of thumb

- **Default to `--depth basic` and `--max 5`.** Escalating to `advanced` doubles cost.
- **Always prefer `map` before `crawl`** when scoping a site — `map` returns URLs cheaply, and you can re-run `crawl` on a filtered subset.
- **`auto_parameters` always costs 2 credits**, even if it picks `basic` internally.
- **`research --model pro`** can reach ~50 credits. Always confirm with the user beforehand.
- **Cache (TTL 6 h)** makes repeated identical queries free. Use `--no-cache` only when freshness matters.
- **`research-poll` is free** — poll every 10–15 s without budget impact.
