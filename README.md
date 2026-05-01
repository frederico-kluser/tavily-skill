# Tavily Skill for Pi, OpenCode, and GitHub Copilot CLI

A cross-agent Tavily skill packaged for **Pi Coding Agent** and still easy to use with **OpenCode** and **GitHub Copilot CLI**.

This repository is structured the **Pi package way** so you can publish it to GitHub and install it with:

```bash
pi install https://github.com/YOUR_USERNAME/tavily-skill
```

It also contains a standard Agent Skill at `skills/tavily/`, so users of other harnesses can copy or symlink that folder into `~/.agents/skills/tavily`.

---

## Why this layout

Pi officially supports sharing skills through **Pi packages** published via **git** or **npm**. A package can expose resources through a `pi` manifest in `package.json` or through conventional directories such as `skills/`.

This repository uses:
- a root `package.json` with the `pi-package` keyword
- a `pi.skills` manifest pointing at `./skills`
- one skill under `skills/tavily/`

That makes it:
- installable via `pi install https://github.com/...`
- compatible with the Agent Skills format
- easy to reuse manually in OpenCode, Copilot CLI, Claude Code, and similar tools

---

## Requirements

- **Node.js 18+**
- **bash**
- **TAVILY_API_KEY** environment variable
- **Optional:** `jq` for examples that extract `request_id` from JSON

---

## Installation

### Option 1 — Install as a Pi package from GitHub
After you publish this repository:

```bash
pi install https://github.com/YOUR_USERNAME/tavily-skill
```

Or:

```bash
pi install git:github.com/YOUR_USERNAME/tavily-skill
```

Pi supports installing packages directly from git repositories. This repository is already structured for that.

### Option 2 — Manual cross-agent install
Clone the repository anywhere, then copy or symlink the skill folder:

```bash
git clone https://github.com/YOUR_USERNAME/tavily-skill.git
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

### Option 3 — Project-local install
Put the skill directory inside a repository at:

```bash
.agents/skills/tavily/
```

For Pi specifically, project-local `.agents/skills/` is a native discovery location.

---

## Configure Tavily

Set your API key without exposing the real value:

```bash
export TAVILY_API_KEY=tvly-...
```

Then reload your shell if needed:

```bash
source ~/.bashrc   # or ~/.zshrc
```

Smoke test:

```bash
tvly --version
tvly search "tavily api hello world" --max 1
```

---

## Repository structure

```text
.
├── docs/
│   └── PUBLISHING.md
├── skills/
│   └── tavily/
│       ├── SKILL.md
│       ├── install.sh
│       ├── bin/
│       │   └── tvly.mjs
│       └── references/
│           ├── COSTS.md
│           └── ENDPOINTS.md
├── .gitignore
├── LICENSE
└── package.json
```

---

## Skill capabilities

The `tavily` skill exposes the main Tavily API workflows through a single `tvly` CLI:

- `search`
- `extract`
- `crawl`
- `map`
- `research-start`
- `research-poll`
- `research`
- `usage`
- local `cost` tracking

### Notable implementation details

- no MCP required
- `tvly --help` and `tvly --version` work without an API key
- `tvly cost` persists local usage in `~/.cache/tavily-skill/usage.jsonl`
- expensive commands are blocked by default unless confirmed
- `research --model pro` is intentionally blocked in sync mode

---

## Security

- This repository contains **no real API keys**.
- Never commit `TAVILY_API_KEY` values.
- The included installer only prints placeholders such as `tvly-...`.
- Review skills before installing, because skills can instruct an agent to run commands.

---

## Publishing notes

If you publish this repository to GitHub, users can install it with Pi directly from git.

If you later also publish it to npm with the `pi-package` keyword, it can appear in the Pi package ecosystem and be installable with `pi install npm:...` as well.

Detailed publish steps are in [docs/PUBLISHING.md](docs/PUBLISHING.md).

---

## License

MIT
