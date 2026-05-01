# Tavily Skill for Pi, OpenCode, and GitHub Copilot CLI

Portable Tavily-powered web search, content extraction, site crawling, URL mapping, and deep research for AI coding agents — **without MCP**.

This repository ships a production-ready Agent Skill at `skills/tavily/` and is also structured as a **Pi package**, so Pi users can install it directly from a git repository while other Agent Skills-compatible tools can use the same skill directory.

---

## Highlights

- **One skill, multiple harnesses**: Pi, OpenCode, and GitHub Copilot CLI
- **No MCP required**: uses a normal CLI (`tvly`) through `bash`
- **Clean default output**: Markdown-first, JSON optional
- **Built-in cost guardrails**: commands estimated above 10 credits are blocked unless explicitly confirmed
- **Async deep research workflow**: `research-start` + `research-poll`
- **Local cache and usage ledger**: repeated identical calls can be free within TTL
- **Useful offline behavior**: `tvly --help`, `tvly --version`, `tvly cost`, and `tvly cache-clear` work without an API key

---

## Supported environments

| Environment | How to use it |
|---|---|
| **Pi Coding Agent** | Install as a Pi package from git, or use `skills/tavily/` directly |
| **OpenCode** | Copy or symlink `skills/tavily/` into `.agents/skills/` or `~/.agents/skills/` |
| **GitHub Copilot CLI** | Copy or symlink `skills/tavily/` into `.agents/skills/` or `~/.agents/skills/` |

---

## Install

### Pi Coding Agent

Once this repository is published, install it from git:

```bash
pi install https://github.com/<owner>/tavily-skill
```

Pi packages can expose skills through the `pi.skills` manifest. This repository is already set up for that.

### Manual install for any Agent Skills-compatible harness

Clone the repository and link the skill directory:

```bash
git clone https://github.com/<owner>/tavily-skill.git
mkdir -p ~/.agents/skills
ln -snf "$PWD/tavily-skill/skills/tavily" ~/.agents/skills/tavily
bash ~/.agents/skills/tavily/install.sh
```

If you prefer copying instead of symlinking:

```bash
mkdir -p ~/.agents/skills
cp -R tavily-skill/skills/tavily ~/.agents/skills/tavily
bash ~/.agents/skills/tavily/install.sh
```

### Project-local install

Put the skill directory in a repository at:

```bash
.agents/skills/tavily/
```

---

## Requirements

- **Node.js 18+**
- **bash**
- **`TAVILY_API_KEY`** environment variable
- **Optional:** `jq` for research examples that extract `request_id` from JSON

Configure Tavily:

```bash
export TAVILY_API_KEY=tvly-...
```

Smoke test:

```bash
tvly --version
tvly search "tavily api hello world" --max 1
```

---

## What the skill provides

The `tavily` skill exposes the main Tavily workflows through a single `tvly` CLI:

- `search`
- `extract`
- `crawl`
- `map`
- `research-start`
- `research-poll`
- `research`
- `usage`
- local `cost` tracking

---

## Usage examples

### Search

```bash
tvly search "latest JavaScript framework trends" --depth basic --max 5
```

### Extract known URLs

```bash
tvly extract https://docs.tavily.com/documentation/api-reference/introduction
```

### Map a documentation site

```bash
tvly map https://docs.tavily.com --limit 50
```

### Crawl a focused subset of a site

```bash
tvly crawl https://docs.tavily.com \
  --select-paths "/documentation/.*" \
  --exclude-paths "/blog/.*" \
  --chunks 3
```

### Start deep research

```bash
JOB=$(tvly research-start "compare search APIs for coding agents" --model pro --confirm-expensive --json | jq -r .request_id)
tvly research-poll "$JOB"
```

### Inspect local usage

```bash
tvly cost
tvly cost --json
tvly cost --reset
```

---

## Cost and safety behavior

- **Start cheap by default**: the skill is designed around `basic` search depth and small result sets first
- **Guardrails for expensive calls**: commands estimated above 10 credits require `--confirm-expensive` or `TAVILY_ALLOW_EXPENSIVE=1`
- **Synchronous `pro` research is blocked**: use `research-start` + `research-poll`
- **Cache enabled by default**: local response cache lives in `~/.cache/tavily-skill/`
- **Usage ledger enabled**: local usage history is stored in `~/.cache/tavily-skill/usage.jsonl`
- **Web content is treated as untrusted input**: the skill prints results, it does not execute page content

---

## Repository layout

```text
.
├── package.json
├── README.md
├── LICENSE
└── skills/
    └── tavily/
        ├── SKILL.md
        ├── install.sh
        ├── bin/
        │   └── tvly.mjs
        └── references/
            ├── COSTS.md
            └── ENDPOINTS.md
```

---

## Security

- This repository contains **no real API keys**
- Never commit `TAVILY_API_KEY` values
- The installer only uses placeholders such as `tvly-...`
- Review any skill before installing, since skills can instruct agents to run commands

---

## License

MIT
