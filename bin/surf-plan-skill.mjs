#!/usr/bin/env node
// surf-plan-skill CLI — thin helper. The planning workflow is in SKILL.md;
// this binary only manages plan files and exposes diagnostics.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolvePlansDir, DEFAULT_HOME_PLANS } from '../src/plan/plans-dir.mjs';
import { listPlans, readPlan, newPlanStub } from '../src/plan/plan-file.mjs';
import { slugify } from '../src/plan/slug.mjs';
import { checkSurfSkill } from '../src/lib/check-surf-skill.mjs';

const VERSION = '7.0.0';

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
      const total = (k.tavily || 0) + (k.parallel || 0) + (k.brave || 0);
      out(`  keys:          ${total} total — tavily ${k.tavily}, parallel ${k.parallel}, brave ${k.brave}`);
      if (total === 0) {
        out(`\n⚠ surf-research-skill has no keys. Run: surf-research-skill setup`);
        process.exitCode = 2;
      }
    }
  } else {
    out(`\nsurf-research-skill: ✗ NOT installed`);
    out(`  ${surf.error || 'command not found'}`);
    out(`  → Install: npm i -g surf-agent-skill && surf-research-skill setup`);
    process.exitCode = 1;
  }

  // Quick sanity check that the SKILL.md is reachable in at least one
  // harness dir.
  const home = process.env.HOME || '';
  const checkDirs = [
    `${home}/.claude/skills/surf-plan-agent-skill/SKILL.md`,
    `${home}/.agents/skills/surf-plan-agent-skill/SKILL.md`,
  ];
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
    out(`\nSKILL.md:        ⚠ not found in ~/.claude/skills/ or ~/.agents/skills/`);
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
