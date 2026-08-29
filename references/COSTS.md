# What a search costs, and what actually limits you

surf v8 has one search backend and one unit of cost: **one Brave request**.

## Money

Brave's 2026 Search plan is **US$ 5.00 per 1,000 requests** — about half a cent
each. Roughly $5 of credit is applied to the account each month (~1,000
requests), and a card is required even if you never exceed the credit.

Grandfathered keys still report `meta.plan: "Free"` with a **2,000 requests /
month** quota, and Brave still enforces it.

Failed requests are **not** billed. That covers 422s (bad key, bad parameter)
and 429s (rate limited) — which is what makes surf's key validation free.

| Operation | Requests |
|---|---|
| `search "one query"` | 1 |
| `search "a" "b" "c"` (batch) | 3 |
| `search-parallel` × N | N |
| one surf-ai **wave** | up to `--sub-agents` (default 10) |
| `keys add` / preflight validation | **0** — the probe is rejected before billing |
| cache hit (6 h TTL) | 0 |

A typical `surf-search-normal` run is one wave: **≤ 10 requests, ~5¢**.
A `surf-search-unlimit` run is one wave per round: `waves × sub-agents`, capped
by `--max-rounds` (default 6) — so at most ~60 requests, ~30¢.

## The limit that actually bites: requests per second

Money is rarely the constraint. **Rate is.**

Brave enforces a 1-second sliding window, counted on arrival. The allowance
depends on the plan:

| Plan | req/s | per month |
|---|---|---|
| Search (2026) | 50 | metered |
| legacy "Free" | **1** | 2,000 |

On a 1 req/s key, `--sub-agents 10` does **not** run ten searches at once. surf
reads the real allowance from Brave's own response headers and paces the fan-out
through a cross-process token bucket, so the wave still completes — it just
takes ~10 seconds instead of ~1. surf warns you when this happens.

**Adding a second Brave key is the only way to widen it.** Each key carries its
own per-second budget, so two keys genuinely double the simultaneity. That is
worth more than raising `--sub-agents`, which above the plan's rate only queues.

Check what surf has learned about your key:

```bash
surf-research-skill keys list      # per-key state, including validation verdicts
surf-research-skill cost           # local request ledger
```

## The LLM is usually the bigger bill

surf-ai makes 2 OpenRouter calls in normal mode (plan + synthesis) and
`2 + waves` in unlimit mode (one analysis per wave). With the default
DeepSeek v4 Pro these are cents, but they scale with the evidence digest, not
with the number of searches — a wide wave makes the *analysis* call expensive,
not the search bill.

The `--ledger` flag prints the per-query coverage table and the rejected
frontier, so you can see exactly what the run spent its budget on.

## Guardrails

- `~/.cache/surf/` caches search responses for 6 h. Repeating a query inside
  that window costs nothing. `--no-cache` opts out; `cache-clear` purges.
- The frontier refuses duplicate queries across waves, so an analyst that keeps
  proposing the same follow-up cannot burn requests re-running it.
- A branch that returns no new sources twice in a row is closed automatically.
- `--confirm-expensive` still exists but can no longer fire on a plain search:
  the maximum estimate for one Brave request is 1.
