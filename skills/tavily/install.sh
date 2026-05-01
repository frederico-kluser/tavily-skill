#!/usr/bin/env bash
# Multi-agent installer for the tavily skill.
# Re-runnable. Configures Pi, OpenCode and GitHub Copilot CLI to discover
# ~/.agents/skills/tavily/ via native paths and defensive symlinks.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_NAME="$(basename "${SHELL:-bash}")"
SHELL_RC="${HOME}/.${SHELL_NAME}rc"

echo "🛠  Installing tavily skill from $SKILL_DIR"

# 1) Node 18+ check
command -v node >/dev/null || { echo "❌ Node 18+ required"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || { echo "❌ Need Node ≥18 (have $NODE_MAJOR)"; exit 1; }

# 2) Make CLI executable
chmod +x "$SKILL_DIR/bin/tvly.mjs"

# 3) PATH symlink + ensure ~/.local/bin is on PATH
mkdir -p "$HOME/.local/bin"
ln -sf "$SKILL_DIR/bin/tvly.mjs" "$HOME/.local/bin/tvly"
if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
  cat >> "$SHELL_RC" <<'EOF'

# tavily-skill: ensure local user binaries are available
export PATH="$HOME/.local/bin:$PATH"
EOF
  echo "✓ added ~/.local/bin to PATH in $SHELL_RC"
fi

# 4) Compatibility symlinks for every agent we know about
for dir in \
  "$HOME/.claude/skills" \
  "$HOME/.copilot/skills" \
  "$HOME/.config/opencode/skills" \
  "$HOME/.pi/agent/skills" \
  "$HOME/.codex/skills"
do
  mkdir -p "$dir"
  ln -snf "$SKILL_DIR" "$dir/tavily"
done

# 5) OpenCode experimental timeouts (defense in depth)
OC_CFG="$HOME/.config/opencode/opencode.json"
mkdir -p "$(dirname "$OC_CFG")"
[ -f "$OC_CFG" ] || echo '{}' > "$OC_CFG"
node -e '
const fs=require("fs"), p=process.argv[1];
let c={}; try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
c["$schema"]=c["$schema"]||"https://opencode.ai/config.json";
c.experimental=Object.assign({},c.experimental,{mcp_timeout:600000});
c.experimental.bash=Object.assign({},c.experimental.bash,{timeout_ms:600000});
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log("✓ wrote",p);
' "$OC_CFG"

# 6) Permanent bash-tool default timeout
if ! grep -q 'OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS' "$SHELL_RC" 2>/dev/null; then
  cat >> "$SHELL_RC" <<'EOF'

# tavily-skill: expand OpenCode bash tool default timeout to 10 min
export OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=600000
EOF
  echo "✓ added OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS to $SHELL_RC"
fi

# 7) API key check
if [ -z "${TAVILY_API_KEY:-}" ]; then
  echo
  echo "⚠  TAVILY_API_KEY is not set in the current shell."
  echo "   Get a key at https://app.tavily.com (1,000 free credits/month)."
  echo "   Add to ~/.secrets or your shell rc:"
  echo "     export TAVILY_API_KEY=tvly-..."
fi

# 8) Smoke-test if key is available
if [ -n "${TAVILY_API_KEY:-}" ]; then
  echo "🔎 Smoke-test…"
  if "$SKILL_DIR/bin/tvly.mjs" --version >/dev/null 2>&1 \
    && "$SKILL_DIR/bin/tvly.mjs" search "tavily api hello world" --max 1 >/dev/null 2>&1; then
    echo "✓ Skill works"
  else
    echo "⚠ Smoke-test failed — check key/network"
  fi
fi

echo
echo "✅ Done. Restart your shell, then:"
echo "   pi              → ask 'search the web for X'"
echo "   opencode        → same"
echo "   copilot         → /skills info tavily   then ask 'search the web for X'"
