#!/usr/bin/env node
// surf-free-skill — FREE, KEYLESS web search (Wikipedia + DuckDuckGo).
//
// No API key, no setup, no keys.json. Returns encyclopedic full-text hits
// (Wikipedia) and instant answers (DuckDuckGo). This is a DELIBERATELY separate
// skill from surf-research-skill: it never touches paid providers or stored
// keys. It is NOT a general-web SERP — for whole-internet, multi-source research
// (Tavily / Parallel / Brave), use surf-research-skill.

import { parseFlags } from '../src/lib/flags.mjs';
import { dispatch, DispatchError } from '../src/lib/dispatch.mjs';
import { formatFor } from '../src/lib/format.mjs';
import { setSilent } from '../src/lib/progress.mjs';

const VERSION = '7.0.0';

const HELP = `surf-free-skill — free, keyless web search (Wikipedia + DuckDuckGo)

No API key, no setup. Returns encyclopedic hits (Wikipedia full-text) and
instant answers (DuckDuckGo). NOT a general-web SERP — for whole-internet,
multi-source research, add keys and use surf-research-skill instead.

Usage:
  surf-free-skill search <query> [flags]
  surf-free-skill <query>                     (search is the default command)

Flags:
  --max <n>                    Limit number of results
  --provider <wikipedia|ddg>   Force one keyless provider (default: wikipedia -> ddg)
  --json                       Print normalized envelope as JSON
  --raw-json                   Print raw provider response
  --no-cache                   Skip the response cache
  --quiet                      Silence progress logs (stderr)
  --help, -h                   Show this help
  --version, -v                Show version

Examples:
  surf-free-skill search "Alan Turing"
  surf-free-skill "quantum computing" --max 5 --json
  surf-free-skill search "Brazil" --provider wikipedia

Chain: wikipedia (broad encyclopedic full-text) -> ddg (instant answers).
Both are free and need no key. For general-web search, use surf-research-skill.`;

function out(msg) {
  if (msg == null) return;
  const s = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  process.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
}
function die(msg, code = 1) {
  process.stderr.write(`❌ Error: ${msg}\n`);
  process.exit(code);
}

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') { out(HELP); process.exit(0); }
if (cmd === '--version' || cmd === '-v') { out(VERSION); process.exit(0); }

// `search` is the default (and only) verb — accept both `search "q"` and `"q"`.
const argv = cmd === 'search' ? rest : [cmd, ...rest];
const { pos, flags } = parseFlags(argv);

if (flags.quiet || process.env.SURF_QUIET === '1') setSilent(true);

const query = pos.join(' ').trim();
if (!query) die('Usage: surf-free-skill search <query>  (or: surf-free-skill "<query>")');

try {
  const envelope = await dispatch(
    'search',
    { query, max: flags.max },
    { ...flags, keyless: true },
  );

  if (flags['raw-json']) {
    out(JSON.stringify(envelope.raw, null, 2));
  } else if (flags.json) {
    out(JSON.stringify({
      provider: envelope.provider,
      operation: envelope.operation,
      latency_ms: envelope.latency_ms,
      usage: envelope.usage,
      data: envelope.data,
    }, null, 2));
  } else {
    out(formatFor(envelope));
  }
} catch (e) {
  if (e instanceof DispatchError) die(`[${e.code}] ${e.message}`);
  die(e.message || String(e));
}
