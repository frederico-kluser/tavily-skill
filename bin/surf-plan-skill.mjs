#!/usr/bin/env node
// surf-plan-skill CLI — thin helper. The planning workflow is in SKILL.md;
// this binary only manages plan files and exposes diagnostics.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolvePlansDir, DEFAULT_HOME_PLANS } from '../src/plan/plans-dir.mjs';
import { listPlans, readPlan, newPlanStub } from '../src/plan/plan-file.mjs';
import { slugify } from '../src/plan/slug.mjs';
import { checkSurfSkill } from '../src/lib/check-surf-skill.mjs';
import { harnessDirs } from '../src/lib/harness-install.mjs';
import { formatGate, EXIT_CONFIG } from '../src/lib/preflight.mjs';
// Single source of the version number: src/lib/version.mjs reads package.json.
import { VERSION } from '../src/lib/version.mjs';

const HELP = `surf-plan-skill — research-grounded execution planning skill

The actual planning is done by your AI agent, which reads the SKILL.md
shipped in this package. This CLI just manages plan files and runs
diagnostics.

Commands:
  list                       List plan files (newest first)
  show <slug-substring>      Cat a plan file (resolves by substring)
  new <task title>           Create a stub plan file, print path
  doctor                     Check surf-research-skill is installed + has keys
  --help, -h                 Show this help
  --version, -v              Show version

Plan dir resolution:
  1. $SURF_PLAN_DIR env var (override)
  2. ./plans/ if it exists
  3. ./.surf-plans/ if it exists
  4. ~/.claude/plans/ (default)

How the workflow runs (your AI agent does this when you ask for a plan):
  Phase 0  Resolve research layer — surf-research-skill CLI, or the
           harness's WebSearch/WebFetch when Bash is blocked (plan mode)
  Phase 1  Project discovery — read CLAUDE.md, package.json, source tree
  Phase 2  MODE DECISION — Normal (most plans) or Deep (vague/high-stakes/
           hard-to-reverse, or the user asked to "raise all doubts first")
  Normal:  baseline research → open conversation → clarify (MAX 5 Qs,
           each preceded by a search) → synthesis research → deliver
  Deep:    + a full AMBIGUITY SWEEP → Ambiguity Register BEFORE any
           question, then research-grounded clarify (5-7 Qs) → synthesis
           research → deliver (two-lock gate: ambiguity + research)
  Deliver: plan file (or plan-mode approval first), with a Research
           Ledger (+ Ambiguity Register in Deep mode) and [^N] citations

THE GATE: the agent may not present any plan — including for plan-mode
approval — before baseline and synthesis research are in the Research
Ledger (Deep mode also requires a complete Ambiguity Register first).

Tell your agent: "make a plan for X"
Examples (your agent does the work):
  > make a plan for adding rate limiting to my Express API
  > design a webhook delivery service
  > architect pagination for my React table

Docs: ~/.agents/skills/surf-plan-agent-skill/SKILL.md`;

function die(msg, code = 1) {
  process.stderr.write(`❌ Error: ${msg}\n`);
  process.exit(code);
}

function out(s) {
  if (s == null) return;
  process.stdout.write(s + (String(s).endsWith('\n') ? '' : '\n'));
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtMtime(d) {
  return d.toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, '');
}

async function cmdList() {
  const plans = await listPlans();
  const dir = await resolvePlansDir({ ensure: false });
  if (!plans.length) {
    out(`No plan files yet in ${dir}.`);
    out('Ask your AI agent: "make a plan for <task>"');
    return;
  }
  out(`**Plans in ${dir}** (${plans.length})\n`);
  for (const p of plans) {
    out(`- ${fmtMtime(p.mtime)}  ${fmtBytes(p.size).padStart(7)}  ${p.name}`);
    out(`    ${p.title}`);
  }
}

async function cmdShow(args) {
  const q = args[0];
  if (!q) die('Usage: surf-plan-skill show <slug-substring>');
  const { path: p, content } = await readPlan(q);
  out(`# ${p}\n`);
  out(content);
}

async function cmdNew(args) {
  const task = args.join(' ').trim();
  if (!task) die('Usage: surf-plan-skill new "<task title>"');
  const p = await newPlanStub(task);
  out(`✓ ${p}`);
  out('');
  out('Now tell your agent: "fill in the plan at this path"');
  out('Or just ask: "make a plan for <task>" and let the agent create the file.');
}

async function cmdDoctor() {
  const dir = await resolvePlansDir({ ensure: false });
  out(`Plan directory:  ${dir}`);
  if (process.env.SURF_PLAN_DIR) {
    out(`  (resolved via SURF_PLAN_DIR env var)`);
  } else if (dir === DEFAULT_HOME_PLANS) {
    out(`  (default; set SURF_PLAN_DIR or create ./plans/ to override)`);
  } else {
    out(`  (project-local)`);
  }

  const surf = await checkSurfSkill();
  if (surf.installed) {
    out(`\nsurf-research-skill: ✓ installed (${surf.version})`);
    if (surf.keyCounts) {
      const k = surf.keyCounts;
      out(`  brave keys:    ${k.brave} configured, ${k.braveUsable} usable`);
      // The verdict itself, always — a count cannot tell "never validated"
      // apart from "validated and good", and both print "1 usable".
      if (surf.gate) out(`  gate verdict:  ${surf.gate.verdict} — ${surf.gate.detail}`);

      // WHY THIS PRINTS formatGate() AND NOT A SENTENCE OF ITS OWN
      // ---------------------------------------------------------
      // It used to own two sentences, chosen by `k.brave === 0`: no key, or
      // "Every Brave key is burned. Run: keys reset". That second branch was
      // the ELSE of a single test, so it spoke for every non-empty ring —
      // and once braveUsable became the gate's verdict rather than a
      // subtraction, "not usable" started covering COOLING and INVALID too.
      // A user whose key was merely sitting out a 429 read that it was burned
      // and ran a `keys reset` that resets nothing relevant; a user whose key
      // was rejected by Brave was told to reset before being told the verdict
      // is cached. The exit code was right and the prose was wrong, which is
      // worse than being wrong twice: the number says "stop" and the text
      // sends you somewhere useless.
      //
      // So this file no longer has an opinion about what to tell you either.
      // formatGate() is the same text `assertProviderReady()` throws before
      // every search, so the doctor and the failing command cannot disagree —
      // including for verdicts this bin has never heard of. UNREACHABLE (the
      // probe got no answer, nothing was cached) is the case that proves the
      // point: its canonical text ends with "Do NOT remove the key on account
      // of this message", advice no local `switch` here would have invented.
      if (k.braveUsable === 0) {
        out('');
        if (surf.gate && surf.gate.verdict) {
          for (const line of formatGate(surf.gate.verdict, surf.gate.detail).text.split('\n')) {
            out(line ? `  ${line}` : '');
          }
        } else {
          // Only reachable against a check-surf-skill build that predates
          // `gate`. Naming a verdict we do not have is the exact bug above,
          // so say only what is known and hand off to the command that can
          // decide.
          out(`  ⚠ No usable Brave key, and this build cannot report which verdict`);
          out(`    the gate reached. Run: surf doctor`);
        }
        process.exitCode = EXIT_CONFIG;
      }
    }
  } else {
    out(`\nsurf-research-skill: ✗ NOT installed`);
    out(`  ${surf.error || 'command not found'}`);
    // One voice about the key gate only: formatGate() (printed below, when the
    // CLI IS installed and the keys are unusable). Advising `setup` here is a
    // second opinion about a gate this branch cannot even reach — the install
    // hint names the package, the gate text names the remedy.
    out(`  → Install: npm i -g surf-agent-skill`);
    process.exitCode = 1;
  }

  // Quick sanity check that the SKILL.md is reachable in at least one
  // harness dir. Same home resolution as the installer: harnessDirs() re-reads
  // os.homedir() on every call, so the doctor and the installer cannot
  // disagree about where the links live (the doctor used to read $HOME and
  // the installer os.homedir(); under sudo/containers the two diverge and a
  // healthy install was reported broken).
  const checkDirs = harnessDirs().map(dir => path.join(dir, 'surf-plan-agent-skill', 'SKILL.md'));
  let foundSkill = false;
  for (const p of checkDirs) {
    try {
      await fs.access(p);
      foundSkill = true;
      out(`\nSKILL.md:        ✓ ${p}`);
      break;
    } catch {}
  }
  if (!foundSkill) {
    out(`\nSKILL.md:        ⚠ not found in any harness skills dir`);
    out(`  → reinstall: npm i -g surf-agent-skill`);
    process.exitCode = process.exitCode || 1;
  }
}

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  out(HELP);
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  out(VERSION);
  process.exit(0);
}

try {
  switch (cmd) {
    case 'list':   await cmdList(); break;
    case 'show':   await cmdShow(rest); break;
    case 'new':    await cmdNew(rest); break;
    case 'doctor': await cmdDoctor(); break;
    default:
      die(`Unknown command: ${cmd}. Try 'surf-plan-skill --help'.`);
  }
} catch (e) {
  process.stderr.write(`❌ Error: ${e.message || String(e)}\n`);
  process.exit(1);
}
