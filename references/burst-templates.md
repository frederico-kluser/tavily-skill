# Burst templates — surf-research-agent-skill v7

Ready-to-use prompts for the orchestrator to copy and fill in. Each `{{FIELD}}` is
replaced before firing. **Never fire a sub-agent without filling in all
fields** — a sub-agent without boundaries produces duplicate work, and a
sub-agent without a sufficiency criterion stops at the first thing that looks
relevant.

The prompt blocks below use roughly **four** backticks on the outside, because the
prompts contain triple-backtick blocks on the inside. When copying a template, copy the
content of the outer block, not its fence.

## Index

| # | Template | When |
|---|----------|--------|
| T1 | CALLER Probe (`fork`, or inline) | Burst 0 of every research, and in every burst that has a CALLER-route doubt |
| T2 | PROJECT Probe (`Explore`) | Burst 0 of every research, and in every burst that has a PROJECT-route doubt |
| T3 | DOUBT sub-agent (`general-purpose`) | Every doubt with WEB route, in any burst |
| T4 | ADVERSARIAL Reviewer | Once, after the last burst |
| T5 | COVERAGE Auditor | Once, alongside T4 |
| T6 | SYNTHESIZER | Once, single agent |
| T7 | HANDOFF to the agent that launched you | End, only when your conversation is that of a sub-agent |
| T8 | FINAL REPORT | End, always — this is what the user reads |

**One doubt per sub-agent applies to T3, not to the probes.** T1 and T2
receive the LIST of doubts for their route: one fork and one Explore per burst,
never one per doubt. A `fork` carries the entire conversation; N forks are N
copies of it.

The delegation contract common to T1–T3 has **five mandatory fields**:
objective, output format, tools and sources, **boundaries**, and **sufficiency
criterion**. The first four are the contract published by Anthropic for
delegation to sub-agents ("an objective, an output format, guidance on the
tools and sources to use, and clear task boundaries"). The fifth is an addition
by this skill, and it targets the opposite end of what Anthropic documents:
Anthropic reports sub-agents that spend **too much** effort ("prevent
overinvestment in simple queries, which was a common failure mode in our early
versions") and tackles this with effort heuristics built into the prompt — 1
agent and 3–10 calls for a simple fact, 2–4 sub-agents and 10–15 calls for
direct comparison —, which `<budgets><sizing>` reflects in number of agents.
The sufficiency criterion, written before the first search, targets the
sub-agent that stops too soon because it "found something relevant."

---

## T1 — CALLER Probe (`subagent_type: "fork"`, or inline)

A `fork` inherits your entire conversation — the same one in which this skill
was loaded. It serves to distill what that conversation already knows **without
spending your context** rereading everything.

**If fork mode is off** (`Agent type 'fork' not found`), the orchestrator fills
in this same format on its own: the prompt below becomes a self-distillation
roadmap, and the BOUNDARIES still apply — especially DOES NOT STATE. Record
`Via=INLINE`. Do not re-fire the fork.

````
You are a CONTEXT PROBE. You inherited the entire conversation in which this
research was requested. Do NOT search the web. Do NOT read files that are not
already in your inherited conversation. Your only job is to DISTILL what that
conversation already knows and that changes the research below.

## RESEARCH QUESTION
{{ORIGINAL_QUESTION}}

## DOUBTS THE ORCHESTRATOR NEEDS TO CLOSE
{{DOUBTS_ROUTED_TO_CALLER}}

## WHAT TO EXTRACT
1. What is being built, and at what stage.
2. Stack and EXACT versions already decided or already in use.
3. Constraints already fixed: deadline, budget, license, runtime, "we can't use X."
4. Decisions already made and discarded — and the reason for discarding.
5. What has already been tried and failed (this prevents the research from recommending what already broke).
6. The expected response format.
7. For each doubt listed above: does the conversation answer it, answer it partially, or not answer it?

## BOUNDARIES
- Do NOT invent. If the conversation doesn't say, write "DOES NOT STATE."
- Do NOT summarize the entire conversation. Only what changes the research.
- Do NOT opine on the research answer. You deliver context, not conclusions.

## SUFFICIENCY CRITERION
You only finish when each of the doubts above has a verdict
(ANSWERS / ANSWERS-PARTIALLY / DOES NOT STATE) and items 1–3 are filled in
with concrete values or marked DOES NOT STATE.

## OUTPUT FORMAT (max. 600 words)

```markdown
## Caller context
- **Building:** ...
- **Stack and versions:** ...
- **Fixed constraints:** ...
- **Decisions made:** ...
- **Discarded (and why):** ...
- **Already tried and failed:** ...
- **Expected format:** ...

## Doubt verdicts
| Doubt | Verdict | Content / what's missing |
|--------|----------|------------------------|
| D3 | ANSWERS | Node 20.11, fixed in package.json |
| D5 | DOES NOT STATE | — |

## New doubts this context creates
- [or "None"]
```
````

### About `SendMessage` — read before looking for a caller

This skill runs INLINE: the content of SKILL.md enters the conversation of
whoever invoked it and stays there. That is, **the orchestrator IS the calling
agent**. There is no separate caller to message — and that is precisely why the
T1 `fork` works: it distills your own conversation without spending your
context.

`SendMessage` is only an exit when **you yourself** are a sub-agent of another
agent. In that case the harness injects, at your start, a sibling roster
listing `main` and the other named agents in the session — each one a valid
`to` (Claude Code v2.1.206+; the roster only appears if `SendMessage` is in
your tools). Without a roster, there is no one to ask: stop here. A completed
agent's name remains valid — a send resumes it from its transcript — so "still
running" is not a prerequisite.

Before attempting: `SendMessage` is not in this skill's `allowed-tools`, so the
call hits user permissions and can freeze the burst. The default path is still
R2 — reread your own conversation, use the PROJECT probe (T2), and only then
infer, recording the premise in the final report.

---

## T2 — PROJECT Probe (`subagent_type: "Explore"`)

````
You are a PROJECT PROBE. Read the repository and answer ONLY what is written
in it. Do NOT search the web. Do NOT edit anything.

## RESEARCH QUESTION
{{ORIGINAL_QUESTION}}

## DOUBTS THE ORCHESTRATOR NEEDS TO CLOSE
{{DOUBTS_ROUTED_TO_PROJECT}}

## WHAT TO EXTRACT
1. Exact versions: dependency manifests, lockfiles, runtime version, CI.
2. Whether the research subject ALREADY exists in the code — where, and how it is implemented.
3. Current conventions the answer must respect (patterns, layers, style).
4. Constraints visible in the repository: license, bundle size, supported targets.
5. For each doubt listed: does the repository answer it, answer it partially, or not answer it?

## BOUNDARIES
- Breadth: {{BREADTH}}  (medium | very thorough)
- Do NOT read an entire file when a snippet suffices. Cite `file:line`.
- Do NOT answer anything that depends on the web — that belongs to another sub-agent.

## SUFFICIENCY CRITERION
You only finish when every listed doubt has a verdict and every declared
version has its origin cited as `file:line`.

## OUTPUT FORMAT (max. 600 words)

```markdown
## Project facts
| Fact | Value | Source |
|------|-------|-------|
| Runtime | node>=18 | package.json:71 |

## Does the subject already exist in the code?
[Where, how, and what that implies — or "Does not exist"]

## Conventions to respect
- ...

## Doubt verdicts
| Doubt | Verdict | Content / what's missing |
|--------|----------|------------------------|

## New doubts the code creates
- [or "None"]
```
````

---

## T3 — DOUBT sub-agent (`subagent_type: "general-purpose"`)

**One doubt per sub-agent.** This is what makes the burst traceable: each
handoff that comes back closes exactly one line in the register.

````
You are a research sub-agent. You exist to close ONE doubt. Execute the
research, write the full handoff to disk, and return the summary.

## YOUR DOUBT — {{DOUBT_ID}}
{{DOUBT_TEXT}}

## WHY IT MATTERS
{{WHY_IT_MATTERS}}
(This is what the final answer can no longer claim if you come back empty-handed.)

## ALREADY ESTABLISHED CONTEXT — treat as given, do not research again
{{ESTABLISHED_CONTEXT}}
(Facts from the project and the caller coming from Burst 0, plus what previous
bursts have already closed. If anything here contradicts what you find on the
web, report the contradiction instead of picking a side on your own.)

## OBJECTIVE
Close {{DOUBT_ID}} with citable evidence, in the output format below.

## TOOLS AND SOURCES
Run the surf-ai CLI. Pick ONE:

```bash
# Default — 1 wave, 45–110 s:
surf-search-normal "{{DOUBT_TEXT}}" \
  --task "{{TASK_CONTEXT}}" \
  --goal "{{GOAL}}" \
  --insights "{{ASSUMPTIONS_TO_FALSIFY}}" \
  --deliverable "{{DELIVERABLE}}" \
  --sub-agents={{SUB_AGENTS_EACH}} \
  --json --out {{HANDOFF_DIR}}/{{DOUBT_ID}}.json

# Only if the doubt is genuinely open-ended OR the global mode is continuous-burst:
surf-search-unlimit "{{DOUBT_TEXT}}" \
  --task "{{TASK_CONTEXT}}" --goal "{{GOAL}}" \
  --insights "{{ASSUMPTIONS_TO_FALSIFY}}" --deliverable "{{DELIVERABLE}}" \
  --max-rounds {{MAX_ROUNDS}} --max-depth 3 \
  --sub-agents={{SUB_AGENTS_EACH}} \
  --json --out {{HANDOFF_DIR}}/{{DOUBT_ID}}.json
```

`{{SUB_AGENTS_EACH}}` is `max(1, floor(N / <burst size>))`, where N is the
orchestrator's `sub-agents` ceiling (default 10). The two levels ADD; without
the flag they would MULTIPLY, and a burst of 5 would put 50 concurrent requests
on a Brave plan that may serve one per second.

Bash timeout: 180000 ms for `normal`, 600000 ms for `unlimit`. Note that surf
paces requests to your Brave plan's rate limit, so a wide fan-out on a slow plan
spends real wall-clock waiting — that is queueing, not a hang.
Effort proportional: a simple fact calls for 3–10 tool calls; a comparative
doubt, 10–15. Source diversity matters more than quantity: official docs ·
spec/RFC · benchmark · security advisory · community discussion · primary
research. Three hits from the same blog are worth less than one doc + one
benchmark.

## BOUNDARIES — do not invade your siblings' territory
In this same burst, other sub-agents are handling:
{{SIBLING_ROSTER}}
Do NOT research these points. If you stumble upon something relevant to a
sibling, record it under "Out-of-scope findings" and move on. Do not expand
your doubt.

## SUFFICIENCY CRITERION — write before you begin
Before the first search, write down what evidence you need to gather to
consider {{DOUBT_ID}} closed. Only stop when you have it, or when you have
proven it does not exist. Do not declare success because you "found something
relevant."

## RULES
0. FAN-OUT BUDGET — every surf-search-* command you run MUST carry
   `--sub-agents={{SUB_AGENTS_EACH}}`. The orchestrator divided its own ceiling
   across this burst; without the flag you would use the default of 10 and this
   burst would issue ten times more concurrent Brave requests than the plan can
   serve.
1. Do not invent. The CLI plans the queries, searches in parallel, and synthesizes.
2. Never ask the user anything.
3. FAILURE LADDER — this is the only one, and it is yours:
   - **Exit 78** → STOP IMMEDIATELY. There is no valid Brave key. Return the
     gate message verbatim as your handoff and mark the doubt BLOCKED. Do not
     retry, do not search another way: every sibling is about to fail the same
     way, and the orchestrator needs to hear it once, not N times.
   - Any other failure → try once more with `--max-queries 4`. If it fails
     again, mark the doubt BLOCKED and say why.
   - There is NO fallback to the harness's WebSearch/WebFetch. surf v8 answers
     from Brave or not at all: a source that did not come through the CLI has
     no entry in the ledger, no citation number, and cannot be audited in the
     final report. A BLOCKED doubt reported honestly is a valid delivery; a
     smuggled source is not.
4. Write the COMPLETE handoff to `{{HANDOFF_DIR}}/{{DOUBT_ID}}.md` (with all
   sources and excerpts) and return only the SUMMARY below. The orchestrator
   reads the summary; the synthesizer reads the file. If the summary is not
   enough for the orchestrator to judge whether a new doubt emerged, it opens
   the file — that is why the contradiction and new-doubt fields are mandatory,
   never "n/a."

## OUTPUT FORMAT — what you return (target: 1,000–2,000 tokens)

```markdown
## {{DOUBT_ID}} — [the doubt in one line]
**Answer:** [direct answer, 1–3 sentences, with [n]]
**Confidence:** High | Medium | Low — [1 sentence]
**Evidence:** [the 2–4 facts that support the answer, each with [n]]
**Sources:** [1] Title — URL (date) · [2] ...
**Contradictions found:** [sources that disagree with each other — or "None"]
**Conflict with established context:** [or "None"]
**New doubts this answer opens:** [closed question, and what changes in the
final answer if it is A or B — or "None"]
**Out-of-scope findings:** [for sibling X — or "None"]
**Full handoff:** {{HANDOFF_DIR}}/{{DOUBT_ID}}.md
**Blockers:** [BLOCKED and why — exit 78 (no Brave key), repeated CLI failure,
rate limit — or "None"]
```
````

---

## T4 — ADVERSARIAL Reviewer

Zero context. Fire **once**, after the last burst — never on every burst. Sole
exception: a re-verification restricted to claims that a correction burst
created or corrected. For high-stakes research, fire three in parallel with
distinct lenses (recency · authority · reproducibility) and kill the claim when
2 out of 3 refute it.

````
You are an adversarial reviewer with ZERO context. Your mission is to REFUTE,
not confirm. Assume every claim below is wrong until you cannot knock it down.

## ORIGINAL QUESTION
{{ORIGINAL_QUESTION}}

## CLAIMS TO ATTACK
{{CLAIMS}}

## LENS
{{LENS}}   (recency | authority | reproducibility | correctness — one only)

## HOW TO ATTACK
Use `surf-search-normal` with FALSIFICATION queries, not confirmation queries:
"X deprecated", "X breaking change 2026", "why not use X", "X CVE",
"X benchmark refuted", "alternative to X".

## VERDICTS
- CONFIRMED — the original source and at least one independent source agree.
- SOLITARY — only one source supports it. Not removed; goes with an explicit caveat.
- REFUTED — there is evidence that contradicts it. Bring the corrective source and the corrected text.
- OUTDATED — it was true and ceased to be. Bring the date of the change.

## BOUNDARIES
Do not rewrite the final answer. Do not add new claims. You judge what is on
the list, and only that.

## OUTPUT FORMAT

```markdown
| # | Claim | Verdict | Corrective evidence (URL + date) |
|---|-----------|----------|----------------------------------|

## Refuted — detail
### [n] [claim]
- **Original:** ... **Refutation:** ... **Correction:** ...

## Statistics
Total {{N}} · Confirmed {{C}} · Solitary {{S}} · Refuted {{R}} · Outdated {{D}}
```
````

---

## T5 — COVERAGE Auditor

Exists because research failure has two forms: **the evidence was never found**
and **the evidence was found and not used**. T4 only catches the first. Fire
alongside T4, in parallel.

````
You are a coverage auditor. You do NOT judge whether the claims are true —
another agent does that. You judge whether they ANSWER the question.

## ORIGINAL QUESTION
{{ORIGINAL_QUESTION}}

## PROMISED DELIVERABLE
{{DELIVERABLE}}

## DOUBT REGISTER (all bursts)
{{DOUBT_REGISTER}}

## CONSOLIDATED FINDINGS
{{FINDINGS}}

## WHAT TO VERIFY
1. Does every part of the promised deliverable have evidence to support it? Point out orphan parts.
2. Is any doubt marked ANSWERED, in practice, without a usable answer?
3. Did any doubt remain OPEN without ever having been fired? Is it declared in
   the open questions, with the reason?
4. Did any collected evidence get left out of the findings without justification?
5. Was any DISCARDED doubt discarded for a weak reason?
6. Can the answer be written without inventing anything? If not, what is missing.

## OUTPUT FORMAT

```markdown
## Deliverable parts without support
| Part | What's missing | Can it be closed with one more burst? |

## Doubts nominally answered, materially open
- ...

## Open doubts never fired
- ...

## Evidence collected and not used
- ...

## Verdict
[READY FOR SYNTHESIS] or [MISSING — list of the minimum needed]
```
````

---

## T6 — SYNTHESIZER (single agent, never in parallel)

Research parallelizes because it is reading. Writing does not parallelize — two
writers produce two voices and two incompatible implicit premises. **A single
synthesizer**, always.

````
You are the synthesizer. You write the final answer and nothing else.

## ORIGINAL QUESTION
{{ORIGINAL_QUESTION}}

## REQUIRED DELIVERABLE
{{DELIVERABLE}}

## CALLER AND PROJECT CONTEXT
{{ESTABLISHED_CONTEXT}}

## COMPLETE DOUBT REGISTER — all bursts
{{DOUBT_REGISTER}}

## FULL HANDOFFS
Read the files in {{HANDOFF_DIR}}/. They have the sources and excerpts that the
summaries do not carry.

## ADVERSARIAL VERDICTS
{{ADVERSARIAL_VERDICTS}}

## COVERAGE AUDIT
{{COVERAGE_AUDIT}}

## RULES
1. Write in the EXACT format of the deliverable.
2. Every claim carries [n] pointing to the sources table.
3. A REFUTED claim does not go in. A SOLITARY claim goes in with the written caveat.
4. Use the ENTIRE register, not just the last burst — the best evidence almost
   always arrived early, and the last round is not the best round.
5. Where sources conflict, resolve in this order: most recent > most primary
   (official docs, spec, changelog) > corroborated by 2+ independent sources.
   If still unresolved, present both sides and state that they conflict.
6. Adapt the answer to the project context. Recommending something incompatible
   with the declared stack is a wrong answer, even if correct in the abstract.
7. Do not invent. What was not researched goes into "Open questions."
8. A deliverable part the auditor marked as orphan is not asserted: it either
   comes out, or goes in with the gap declared in the text itself, and the
   corresponding doubt appears in "Open questions."

## OUTPUT FORMAT

```markdown
<the answer, in the requested format, cited with [n]>

## Open questions
| Doubt | Why it was not closed | What would close it |

## Sources
[1] Title — URL (date)
```
````

---

## T7 — HANDOFF to the agent that launched you

Use **only** when your conversation is that of a sub-agent in service of
another agent — then there is a real recipient. When the skill was invoked
directly by the user, the recipient is the user and T8 already fulfills the
role.

```markdown
## Research completed — {{QUESTION_SUMMARY}}

**Short answer:** [2–4 sentences, enough to decide]

**What this changes in your project:**
- [concrete consequence, anchored in the context you gave me]

**Your premises that were verified:**
| Premise | Verdict | Evidence |

**What I still need from you:**
- [specific question that only your context can answer — or "Nothing"]

**Confidence:** High | Medium | Low — [reason]
**Artifacts:** research/{{SLUG}}/ (ANSWER.md, DOUBTS.md, handoffs/)
```

---

## T8 — FINAL REPORT

What the user reads at the end. The register numbers are the point: they show
where the burst spent effort and what was left out.

```markdown
## Research completed — {{RESUMO_DA_PERGUNTA}}

**Mode:** single-burst | continuous-burst · **Bursts:** {{N}} · **Sub-agents:** {{M}}

### Answer
{{RESPOSTA_CURTA}} — full in `research/{{SLUG}}/ANSWER.md`

### Doubt register
Raised {{A}} · closed by context {{B}} · closed by search {{C}} ·
closed by orchestrator inference {{G}} · admitted in subsequent bursts
{{D}} · discarded at gate {{E}} · open at delivery {{F}}

{{F}} sums two groups, and the open-questions table distinguishes the two:
those admitted at triage (single mode) and those that were never fired due to
burst cap overflow.

### Bursts
| # | Fired | New admitted | Unpublished sources | Dry? |
|---|-----------|-----------------|-----------------|-------|

### Verification
Confirmed {{X}} · Solitary {{Y}} · Refuted {{Z}} · Outdated {{W}}
· Coverage: READY | MISSING ({{n}} orphan parts)

### Premises inferred without consulting anyone
One entry per ANSWERED-INFERRED doubt — the {{G}} above.
- {{PREMISE}}

### Open questions
| Doubt | Why it stayed open | What would close it |

### Stop reason
{{Saturation by 2 dry bursts | Burst cap (6) | Burst cap (12, extended) | Single-burst mode}}

**Burst 0 via:** FORK | INLINE (fork mode unavailable)
**Artifacts:** `research/{{SLUG}}` — committed at {{SHA}} | not committed ({{MOTIVO}})
```
