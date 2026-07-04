#!/bin/sh
# Magpie installer — one line, no Node/npm/docker required.
#
#   curl -fsSL https://raw.githubusercontent.com/ssh-ai/magpie/main/scripts/install.sh | sh
#
# Installs the magpie binaries (CLI, relay, MCP server — all standalone) into
# ~/.magpie/bin and auto-registers the MCP server with any agents it can detect
# (Claude Code today; prints snippets for Codex / Antigravity).
set -eu

REPO="ssh-ai/magpie"
INSTALL_DIR="${MAGPIE_HOME:-$HOME/.magpie}/bin"
BASE="https://github.com/$REPO/releases/latest/download"

# --- detect platform ---------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "unsupported OS: $os (Windows: use install.ps1)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo "unsupported arch: $arch"; exit 1 ;;
esac
target="$os-$arch"

# --- download + unpack -------------------------------------------------------
echo "→ installing magpie ($target) to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$BASE/magpie-$target.tar.gz" -o "$tmp/magpie.tar.gz"
tar -xzf "$tmp/magpie.tar.gz" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/magpie" "$INSTALL_DIR/magpie-relay" "$INSTALL_DIR/magpie-mcp"

# --- PATH --------------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    line="export PATH=\"$INSTALL_DIR:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [ -f "$rc" ] && ! grep -qs "$INSTALL_DIR" "$rc" && printf '\n# magpie\n%s\n' "$line" >> "$rc"
    done
    echo "→ added $INSTALL_DIR to PATH (restart your shell)"
    ;;
esac

# --- auto-register the MCP server with detected agents ------------------------
ext="@$(whoami)/main"

if command -v claude >/dev/null 2>&1; then
  if claude mcp get magpie >/dev/null 2>&1; then
    echo "→ Claude Code: magpie MCP already registered"
  else
    claude mcp add magpie --scope user -e MAGPIE_EXTENSION="$ext" -- "$INSTALL_DIR/magpie-mcp" \
      && echo "→ Claude Code: registered magpie MCP (extension $ext)" \
      || echo "! Claude Code: auto-register failed — run: claude mcp add magpie -e MAGPIE_EXTENSION=$ext -- $INSTALL_DIR/magpie-mcp"
  fi
fi

if [ -f "$HOME/.codex/config.toml" ]; then
  if grep -qs "mcp_servers.magpie" "$HOME/.codex/config.toml"; then
    echo "→ Codex: magpie MCP already registered"
  else
    cat >> "$HOME/.codex/config.toml" <<EOF

[mcp_servers.magpie]
command = "$INSTALL_DIR/magpie-mcp"
env = { MAGPIE_EXTENSION = "$ext" }
EOF
    echo "→ Codex: registered magpie MCP (extension $ext)"
  fi
fi

echo ""
echo "✅ magpie installed."
echo ""
echo "Start a call:   tell your agent  \"start a magpie call about <topic>\""
echo "                → it prints an invite like  K7F3-9M2P-XQ4R@ws://host:8787"
echo "Join a call:    tell your agent  \"join <invite>\"   (no other setup needed)"
echo "Run a relay:    magpie-relay        # one side runs this on a reachable host"
echo ""
echo "Other agents (Antigravity, …): register the MCP command manually:"
echo "  $INSTALL_DIR/magpie-mcp   (env: MAGPIE_EXTENSION=$ext)"
