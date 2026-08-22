---
name: surf-free-agent-skill
description: >-
  Free, KEYLESS web search — no API key, no setup, no config. Encyclopedic
  full-text via Wikipedia + instant answers via DuckDuckGo. Use ONLY when the
  user explicitly wants free / no-key / no-config search, a quick factual or
  encyclopedic lookup, or has no API keys configured. Triggers on "busca
  grátis", "busca gratuita", "pesquisa grátis", "sem chave", "sem API", "sem
  key", "free search", "no API key", "no-key search", "keyless search", "quick
  lookup", "look this up for free", "wikipedia lookup", "define X for free". Do
  NOT use for general-web / whole-internet research, multi-source deep dives,
  "find everything about X", crawling, or when result quality matters — use
  surf-research-agent-skill (Tavily / Parallel / Brave) for that. Do NOT use for
  planning (surf-plan-agent-skill), local files, git, or code.
license: MIT
argument-hint: "<what to look up, free — e.g. 'Alan Turing'>"
allowed-tools: Bash(surf-free-skill:*), Read
metadata:
  version: "5.4.0"
  requires: "node>=18; install via `npm i -g surf-agent-skill` (bundles surf-research-agent-skill with its surf-ai loop + surf-plan-agent-skill + surf-free-agent-skill); NO API key needed — search is answered by Wikipedia + DuckDuckGo."
---

# surf-free-agent-skill — free, keyless web search

Zero API keys, zero setup. Answers a `search` from two free sources:

- **Wikipedia** (MediaWiki full-text) — broad, reliable; returns article hits + snippets for almost any informational query.
- **DuckDuckGo Instant Answer** — instant answers / entity definitions (blank for most non-entity phrases), used as the safety net.

Chain: `wikipedia → ddg`. It **never** touches paid providers or `~/.config/surf/keys.json`.

## When to use this — and when NOT to

| Use **surf-free-agent-skill** | Use **surf-research-agent-skill** instead |
|---|---|
| No API keys / "sem chave" / "busca grátis" | Real general-web search across the internet |
| Quick factual / encyclopedic lookup | Multi-source, cited, "find everything about X" |
| "who/what is X", "define X" (free) | Deep research, parallel fan-out, extract/crawl/map |

This skill is **encyclopedic + instant-answers only — NOT a general-web SERP.**
If the user needs whole-internet coverage or quality matters, tell them to add a
key and use `surf-research-agent-skill`. Do not use this skill just because the user
said "search" — use it only when *free / no-key* is the point.

## Commands

```bash
surf-free-skill search "Alan Turing"           # wikipedia → ddg
surf-free-skill "quantum computing" --max 5     # `search` is the default verb
surf-free-skill search "Brazil" --json          # normalized JSON envelope
surf-free-skill search "pi" --provider ddg       # force one keyless provider
```

Output is the **same normalized envelope** as surf-research-agent-skill —
`{ provider, operation, data: { query, answer, results: [{ url, title, content }] } }`
— so callers parse it identically. Use `--json` for machine parsing, `--quiet`
to silence stderr progress.

## Notes

- **No keys, no cost.** Every result is 0 credits.
- **Wikipedia language:** set `SURF_WIKIPEDIA_LANG` (default `en`) — e.g. `pt` for Portuguese.
- For anything beyond free encyclopedic / instant-answer lookups, defer to `surf-research-agent-skill`.

### Keep the loop going

After answering, suggest 1-2 follow-up lookups the result raised and offer to
continue. If the answer shows the question is bigger than free keyless search
can serve, say so and point at `surf-research-agent-skill` — better to redirect than
to return a thin answer the user asked for depth on.
