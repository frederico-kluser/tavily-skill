---
name: surf-search-agent-skill
description: >-
  Web search for ONE question, answered and cited, with no orchestration. One
  surf-search-normal call (Brave Search, and nothing else) returns the answer
  with [n] citations and the source table. No sub-agents, no doubt ledger, no
  files on disk, no commit. Use when the question is ONE independent question
  with ONE verifiable answer: a number, a version, a date, a limit, a price, an
  error message, "is this still true?", "how do I do X", or comparing two
  options on a SINGLE axis. Also for a plain list of links. Triggers on:
  pesquise, procura na web, me acha, qual a versao de, ainda existe, isso
  mudou, quanto custa, o que e, como faco, search the web, look this up, what
  is, how do I, is X still, does X support. Brave only - without a VALID Brave
  key every command exits 78 and this skill STOPS; there is no fallback
  provider and no WebSearch reserve. DO NOT use when the answer needs MORE THAN
  ONE independent question - when sub-questions depend on each other and each
  answer rewrites the next question - nor when the user asks for a
  levantamento, panorama, "tudo sobre", "deep dive", a comparison of 3+ options
  or of 2 options across several axes, nor when the user wants a written trail
  of what was asked and what stayed open: all of those are
  surf-research-agent-skill. DO NOT use to write an execution plan - that is
  surf-plan-agent-skill. Not for local files, git or code editing. Not for
  reading a specific URL either: Brave returns ranked links and snippets,
  never page content.
license: MIT
argument-hint: "the question - optionally links-only"
allowed-tools: Bash(surf-search-normal:*), Bash(surf-research-skill search:*), Bash(surf-research-skill search-parallel:*), Read
model: inherit
effort: medium
metadata:
  version: "8.0.1"
  requires: "a VALID BRAVE SEARCH key FIRST (surf-research-skill setup, or surf-research-skill keys add --provider brave <key> - stored in ~/.config/surf/keys.json, or $BRAVE_API_KEY / $BRAVE_API_KEYS, or ./.env): without it EVERY command here exits 78 before it searches anything, and there is no second provider to fall through to; node>=18; npm i -g surf-agent-skill for surf-search-normal + surf-research-skill in PATH; OPTIONALLY an OpenRouter key (surf-research-skill ai-setup) - without it surf-search-normal still exits 0 but degrades to cited EVIDENCE instead of an LLM synthesis, and this skill MUST say so out loud"
---

# surf-search — one question, one answer, cited

You are the agent the user is talking to. This skill is the **shallow** half of
a pair. Its whole reason to exist is the case where there is nothing to
decompose: the user asked **one** question that has **one** verifiable answer,
and the honest way to serve it is one search and one answer — not an
orchestration.

**The boundary, and it is the only one:**

> **How many independent questions does the answer require?**
> **One → this skill. More than one, or you cannot tell → `surf-research-agent-skill`.**

Independent means the sub-questions do not feed each other. If answering
question B requires first knowing the answer to question A — so that A's answer
rewrites what B even is — that is not one question, and this skill is the wrong
tool. Count the questions before you search; the count is observable up front.

The boundary is **not** how fast the user wants it, **not** how important the
answer is, and **not** how hard the question looks. Those are opinions, they
pull in different directions, and they would make this skill and its deep
sister fight over the same request.

---

## The flow — 5 steps, zero sub-agents

### 1. Restate in one line, and name the shape of the answer

Write the question as one sentence, then name what the answer will look like:
"one sentence", "a two-row table", "one command", "a version number", "a list
of links".

If, while writing that line, you need an **"and"** joining two independent
questions — stop. That is step 5c: say it out loud and escalate.

### 2. One call. No pre-gate.

Do **not** run `surf-research-skill keys list` first — it validates nothing and
always exits 0, so it cannot tell you whether the key works. The real gate is
`preflightOrExit()` inside the binary itself (`bin/surf-search-normal.mjs:111`),
which runs before the LLM plans anything.

```bash
surf-search-normal "<the question>" \
  --task "<what the person is doing right now>" \
  --goal "<the decision this feeds>" \
  --insights "<what they already believe - it gets falsified, not assumed>" \
  --deliverable "<the exact shape of answer you named in step 1>" \
  --json
```

Set the **Bash timeout to 180000 ms**. A normal run is 45–110 s.

**Links-only mode** (no LLM, exactly one Brave request) — when what the person
actually wants *is* the list of results, or when you need a Brave filter the
synthesis path does not expose (`--time`, `--domains`, `--country`, `--goggles`):

```bash
surf-research-skill search "<the question>" --max 5 --json
```

### 3. Read the four signals BEFORE you believe the answer

These are the real field names in the `--json` payload (`renderJson`,
`src/lib/ai/render.mjs:186-203`). Read them in this order:

1. **`ledger.stats.failed`** — how many searches failed, out of
   `ledger.stats.queries` (`src/lib/ai/ledger.mjs:153-162`). Greater than zero
   means coverage is thinner than it looks; lower the confidence you declare in
   step 4.
2. **`synthesized`** — a top-level boolean, true **only** when the LLM
   synthesis actually produced the answer (`src/lib/ai/orchestrator.mjs:499`,
   `:523`). **`false` means what you are holding is evidence, not a synthesis.**
3. **`diagnostics.degraded`** — an array of `{stage, reason}`
   (`src/lib/ai/orchestrator.mjs:204`). In rendered (non-JSON) output the same
   thing shows as `> ⚠ Degraded stage(s): **<stage>** (<reason>)`
   (`src/lib/ai/render.mjs:176`), or, when the LLM was unreachable for the whole
   run, as the header `> ⚠ **Degraded mode — no LLM synthesis.**`
   (`src/lib/ai/heuristics.mjs:127`).
4. **`stop_reason`** — resolved, or out of budget.

> **Do not look for `diagnostics.queriesFailed`.** No code anywhere writes it —
> the real counter is `ledger.stats.failed`. A check against the ghost name
> silently reads `undefined`, which is falsy, so "no query failed" and "that
> field does not exist" look identical and the run always looks clean.
> `references/surf-ai-cli.md` now lists this name, and the other names nothing
> writes, under **"Campos que NÃO existem"** — with the real field beside each.

> **MANDATORY — declare degraded mode.** If `synthesized` is `false`, or
> `diagnostics.degraded` is non-empty, or either `⚠ Degraded` line appears in
> the output, you MUST open your reply by
> telling the user, in plain words, that **the LLM synthesis did not happen and
> what they are getting is cited evidence assembled deterministically, not a
> synthesized answer** — and name the stage and the reason the tool gave. This
> is not optional and it is not a footnote. An OpenRouter key that is missing,
> expired, or rejected for auth produces exactly this state while still exiting
> 0, so a silent reply here would promise a synthesis that was never produced.
> The Brave results are still real and still cited; the *reasoning over them* is
> what is missing. Say which one you have.

### 4. Answer in at most 10 lines

With `[n]` citations and the source table, plus three things, in this order:

- **Confidence** — Alta / Média / Baixa, with the reason in one sentence.
- **What was NOT checked** — the edge of what this one search covered.
- **The date of the freshest source**, whenever the answer is the kind that
  ages (versions, prices, limits, "is X still…").

### 5. Escalate out loud — never in silence

Say **"this is a case for `surf-research-agent-skill`, want me to run it?"** and
then **stop**, whenever any of these is true:

- **(a)** the answer came back with **Baixa** confidence;
- **(b)** the sources **contradict each other**;
- **(c)** closing the question would need a **second independent question**;
- **(d)** the answer depends on something about **this project or conversation**
  that you do not have (the deep skill has a context burst for exactly this);
- **(e)** the user signalled the decision is **hard to reverse**.

You escalate by **saying so**. You never invoke the deep skill yourself — you
have no `Agent` and no `Task` tool, and that is deliberate.

**One retry, and only one.** If the CLI fails for any reason other than 78, run
it exactly once more with `--max 3`. If it fails again, say it failed. If it
exits **78**, return the gate's message **verbatim** and stop — there is no
plan B, no second provider, and no WebSearch underneath
(`src/lib/preflight.mjs`, `EXIT_CONFIG = 78`).

---

## What this skill does NOT do

Every row is something the deep sister does and this one does not. This table
*is* the boundary contract.

| Not here | Where it lives in `surf-research-agent-skill` |
|---|---|
| Raise doubts, keep a doubt ledger | the doubt bursts |
| Spawn any sub-agent (no `Agent`/`Task` in `allowed-tools`) | R3, the burst |
| Context burst (fork of the caller + Explore of the repo) | burst 0 |
| Admission gate and triage | the triage phase |
| Adversarial verification, coverage audit | T4 / T5 |
| A separate synthesizer | T6 |
| Create `research/{{SLUG}}/`, write `DOUBTS.md` / `FINDINGS.md` / `ANSWER.md`, `git commit` | delivery phase |
| Continuous mode, convergence, burst ceiling | continuous-burst |
| More than one search call (beyond the single retry) | every mode |
| Read the contents of a page — only what Brave returns | nowhere: Brave never returns page content |

No `Write`, no `Bash(git:*)`, no `Bash(mkdir:*)` in `allowed-tools`: **this skill
leaves nothing on disk.** That is part of its definition, not an oversight.

No `WebSearch` and no `WebFetch` either. surf v8 is Brave-only by decision
(`src/lib/preflight.mjs`). An agent that fell back to the harness's own web
search when the Brave key is missing would re-open exactly the hole v8 closed:
an answer that looks sourced but never passed the gate, with no ledger and no
citation numbering behind it.
