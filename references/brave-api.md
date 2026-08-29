# Brave Search API — what surf actually relies on

surf v8 has exactly one search backend: `GET https://api.search.brave.com/res/v1/web/search`.
This file records what that endpoint really does, because several of its
behaviours are surprising and three of them caused live bugs in v7.

Everything below was verified against the API on **2026-08-29**, either by
reading the official docs at `api-dashboard.search.brave.com` or by calling the
endpoint directly. Where the two disagreed, the live call wins and the
disagreement is noted.

---

## Auth

```
X-Subscription-Token: <key>      # NOT Bearer, NOT ?apikey=
Accept: application/json
Accept-Encoding: gzip
```

## The three things that trip people up

### 1. HTTP status cannot tell a bad key from a bad parameter

Both answer **422**. Branch on `error.code`, never on the status:

| `error.code` | HTTP | Means | surf's `kind` | Burns the key? |
|---|---|---|---|---|
| `SUBSCRIPTION_TOKEN_INVALID` | 422 | the key is wrong | `auth` | **yes** |
| `VALIDATION` | 422 | a parameter is wrong | `config_4xx` | no |
| `OPTION_NOT_IN_PLAN` | 400 | your plan lacks that feature | `plan_gate` | no |
| `RATE_LIMITED` | 429 | too many requests this second | `rate_limit_429` | no (cooldown) |

Real bodies:

```json
{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided API key is invalid.",
          "meta":{"component":"authentication"},"status":422},"type":"ErrorResponse"}

{"error":{"code":"OPTION_NOT_IN_PLAN","detail":"The option is not included in the plan.",
          "meta":{"component":"authentication"},"status":400},"type":"ErrorResponse"}
```

**Note the trap:** `OPTION_NOT_IN_PLAN` also carries
`meta.component: "authentication"` — and the key is perfectly good. Branching on
`meta.component` would burn a working key the first time someone touched a
plan-gated feature. Only `error.code` is safe.

v7 classified every 422 as `auth`, so a single `--country zzz` burned every key
in the ring, permanently (burns persist until the next calendar month).

### 2. Validating a key costs nothing

Failed requests are not billed. Brave documents this twice, and an A/B of 108
deliberately-failing requests moved the monthly counter by exactly zero.

So the cheapest and most reliable key check is a request with **no `q`**:

```
GET /res/v1/web/search           (with the token, without q)
  → 422 VALIDATION                  the key was accepted → GOOD
  → 422 SUBSCRIPTION_TOKEN_INVALID  the key was rejected → BAD
```

Zero credits, zero quota. This is what makes surf's preflight gate affordable
to run on every invocation (`src/lib/preflight.mjs`), rather than a one-off at
setup time.

Caveat: free in money, not in throughput. A failed request still increments the
per-second arrival counter and can itself trigger a 429 — so validate once, not
in a retry loop. surf paces the probe through the same rate limiter as a real
search, which is why the gate is cached for 7 days in `keys.json`.

### 3. Pagination is capped, and `offset` is a PAGE index

| Parameter | Range | Note |
|---|---|---|
| `count` | 1–20 | results per page; 422 above 20 |
| `offset` | 0–9 | **pages** to skip, not results; 422 above 9 |

The arithmetic ceiling is ~200 results per query string, but the practical
yield is lower — the well typically runs dry around offset 6–7, and Brave warns
that consecutive pages may overlap.

Gate the next page on `query.more_results_available`, and read an **absent**
field as false: when results are exhausted the key is missing from the response,
not set to `false`. A naive `data.query.more_results_available ?? true` loops
forever.

**Consequence for a research loop:** depth comes from asking *different*
questions, never from paging deeper. That is the whole reason
`src/lib/ai/frontier.mjs` exists.

---

## Rate limiting

A **1-second sliding window**, counted **on arrival** — processing time is
irrelevant, and a request that fails still consumed its slot.

Every 200 and every 429 carries four headers (422s carry none):

```
x-ratelimit-limit:     1, 2000
x-ratelimit-policy:    1;w=1, 2000;w=2678400
x-ratelimit-remaining: 0, 118
x-ratelimit-reset:     1, 183945
```

Parse the `w=1` bucket for the per-second allowance; do not assume field order,
and do not assume the monthly window is 30 days (31 days observed where the docs
say 30). **There is no `Retry-After` header** — `x-ratelimit-reset` is the only
backoff signal.

A 429 body is the cheapest plan probe there is:

```json
{"error":{"code":"RATE_LIMITED","detail":"Request rate limit exceeded for plan",
  "meta":{"plan":"Free","rate_limit":1,"rate_current":1,
          "quota_limit":2000,"quota_current":1883}}}
```

surf learns from both (`src/lib/ratelimit.mjs`) and paces requests through a
**cross-process** ledger under `~/.cache/surf/ratelimit.json`. Cross-process
matters: the sub-agents of `surf-research-agent-skill` are separate OS
processes, so an in-process semaphore would let ten of them each fire N
requests in the same second.

**This is why `--sub-agents 10` does not always mean ten at once.** On a legacy
1 req/s plan, ten sub-agents are serialised to roughly one search per second in
total. Adding a second Brave key genuinely doubles the throughput, because each
key carries its own budget.

---

## Quality parameters

The ones that change what you get back:

| Parameter | Value | Why surf sends it |
|---|---|---|
| `text_decorations` | `0` | Off by default Brave wraps every query-term match in `<strong>`. That markup used to reach markdown output and LLM prompts verbatim. |
| `extra_snippets` | `true` | Up to 5 additional excerpts per result, alongside `description`. The single biggest quality lever on this endpoint. |
| `freshness` | `pd`/`pw`/`pm`/`py` or `YYYY-MM-DDtoYYYY-MM-DD` | Backs `--time` and `--start-date`/`--end-date`. |
| `result_filter` | `web,news,discussions,faq,…` | Backs `--topic news`. |
| `country`, `search_lang`, `ui_lang`, `safesearch` | | Passed through, validated first. |
| `goggles` | a Goggle URL | Custom re-ranking. Max 3 per request. Only the legacy `goggles_id` parameter is deprecated; Goggles themselves are not. |

**`extra_snippets` is plan-gated and fails SILENTLY.** On a plan without it the
request returns HTTP 200 and the field is simply absent from every result. Treat
a missing array as a plan signal, never as an error, and never gate key
validation on it.

### Search operators go inside `q`

Not as separate parameters. `q` is capped at **400 characters / 50 words**.

Supported (officially "experimental"): `"exact phrase"`, `-exclusion`, `site:`,
`filetype:`, `ext:`, `intitle:`, `inbody:`, `inpage:`, `lang:`, `loc:`, and
uppercase `AND`/`OR`/`NOT`.

**Multiple `site:` operators must be OR-grouped.** `site:a.com site:b.com` is
ANDed, and no page lives on two domains, so the naive form returns nothing. surf
emits `(site:a.com OR site:b.com)` and keeps the user's original query in the
response envelope so citations and the ledger stay honest.

The response echoes what was applied in `query.search_operators`:
`{applied, cleaned_query, sites}` — worth checking when a filter seems ignored.

---

## The response

| Field | Contents |
|---|---|
| `web.results[].description` | one snippet, HTML-ish unless `text_decorations=0` |
| `web.results[].extra_snippets` | up to 5 more excerpts (plan-gated) |
| `web.results[].page_age` | **ISO-8601** — the one to use |
| `web.results[].age` | display string ("July 4, 2026") — never send this to a model |
| `web.results[].meta_url`, `.profile` | site identity, favicon, breadcrumb |
| `query.more_results_available` | present-and-true, or **absent** |
| `query.search_operators` | which operators actually applied |

There is **no page content** and **no relevance score**.

There is also **no synthesized answer**. The `summarizer` block appears only
when `summary=1` is sent *and* the plan includes it, and even then it is an
opaque handle requiring a second call to `/summarizer/search` at a much lower
rate limit. v7 read `data.summarizer.summary` on a plain search, which is always
`undefined` — dead code that quietly promised an answer field it never filled.

---

## Pricing and plans (2026)

Three plans: **Search**, **Answers**, **Enterprise**. The older
Free / Base / Pro / Data-for-Search / Data-for-AI taxonomy is gone.

- Search: **$5.00 per 1,000 requests**, 50 req/s.
- Answers: $4.00 per 1,000 + token charges, 2 req/s.
- There is no standalone zero-cost tier; ~$5 of credit is applied monthly
  (roughly 1,000 Search requests) and a card is required even for credit-only use.

**Grandfathered keys still exist.** A legacy key reports `meta.plan: "Free"` at
1 req/s and 2,000 requests/month, and Brave still enforces those numbers. Do not
assume the current plan's 50 req/s — read it from the headers.

---

## The endpoint surf does not use: `/res/v1/llm/context`

Since 2026-02 Brave ships an **LLM Context** endpoint that returns
*pre-extracted page content* — text, tables, JSON-LD, code — shaped for machine
consumption, on the same Search plan at the same price. Brave's own docs steer
agent and chatbot workloads to it rather than to `/web/search`.

That is exactly what a research tool wants, and it is the honest answer to
"Brave gives you snippets, not pages". surf does not use it for one reason:

```
GET /res/v1/llm/context → HTTP 400
{"error":{"code":"OPTION_NOT_IN_PLAN","detail":"The option is not included in the plan."}}
```

It is gated. A key without it gets a clean 400, which surf classifies as
`plan_gate` and does **not** burn.

If you upgrade to a plan that includes it, this is the highest-value change
available to this codebase: add it as a second operation in
`src/lib/providers/index.mjs`, and the whole "no page content" limitation —
including the `extract` verb removed in v8 — becomes solvable without adding a
second provider. Parameters: `q`, `country`, `search_lang`, `count`,
`safesearch`, `maximum_number_of_tokens` (1024–32768, default 8192),
`maximum_number_of_urls` (1–50, default 20), `maximum_number_of_snippets`,
`context_threshold_mode` (`strict`/`balanced`/`lenient`/`disabled`),
`enable_local`, `goggles`. It returns `grounding.generic[]` with
`{url, title, snippets[]}`.

---

## Sources

Brave's documentation site is a single-page app that serves identical payloads
for several sub-paths, so URLs are unreliable anchors — cite the section
heading. Primary references:

- `https://api-dashboard.search.brave.com/api-reference/web/search/get` — the machine-readable reference
- `https://api-dashboard.search.brave.com/app/documentation/web-search/query` — parameters and best practices
- `https://api-dashboard.search.brave.com/documentation/guides/rate-limiting` — the sliding window and the headers
- `https://api-dashboard.search.brave.com/documentation/pricing` — the 2026 plans
- `https://api-dashboard.search.brave.com/documentation/services/llm-context` — the endpoint above

Everything here is a 2026-08-29 snapshot of a product that changed substantially
in the preceding seven months. The pagination caps (20/9) are the most stable
facts on this page; pricing and rate limits should be re-checked before you rely
on them.
