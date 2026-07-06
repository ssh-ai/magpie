#!/bin/sh
# Run a public Magpie relay from a spare Mac (or any machine), free.
#
#   sh deploy/relay/macbook.sh
#
# Builds the DoS-hardened relay from this repo, starts it on localhost, and
# opens a free Cloudflare quick tunnel so it's reachable at a public wss://
# URL — no domain, no cloud account, no card. Prints the URL to paste into
# the relay pointer (site/relay.txt).
#
# Trade-off: the tunnel URL is EPHEMERAL (changes if this restarts). That's
# exactly why the default relay is resolved from a pointer file — when the URL
# changes, edit site/relay.txt once and every client follows. For a permanent
# address, move to a cloud box later (deploy/relay/setup.sh) and update the
# pointer; clients need no change.
set -eu

PORT="${MAGPIE_RELAY_PORT:-8787}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

# --- 1. build the hardened relay from source (arch-agnostic) ------------------
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is required to build the relay. Install it with:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "…then re-run this script."
  exit 1
fi
echo "→ building magpie-relay (release) from $ROOT/rust"
cargo build --release --manifest-path "$ROOT/rust/Cargo.toml" -p magpie-relay
RELAY_BIN="$ROOT/rust/target/release/magpie-relay"

# --- 2. ensure cloudflared ----------------------------------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "→ installing cloudflared via Homebrew"
    brew install cloudflared
  else
    echo "cloudflared is required for the public tunnel. Install it with:"
    echo "  brew install cloudflared        # macOS"
    echo "  # or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
fi

# --- 3. run relay + tunnel, print the public URL ------------------------------
tunnel_log=$(mktemp)
cleanup() {
  [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$tunnel_log"
}
trap cleanup EXIT INT TERM

MAGPIE_RELAY_HOST=127.0.0.1 MAGPIE_RELAY_PORT="$PORT" "$RELAY_BIN" &
RELAY_PID=$!
echo "→ relay running on 127.0.0.1:$PORT (pid $RELAY_PID)"

cloudflared tunnel --url "http://localhost:$PORT" >"$tunnel_log" 2>&1 &
TUNNEL_PID=$!

echo "→ opening Cloudflare tunnel…"
url=""
i=0
while [ $i -lt 30 ]; do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | head -1 || true)
  [ -n "$url" ] && break
  sleep 1
  i=$((i + 1))
done

if [ -z "$url" ]; then
  echo "! tunnel URL did not appear; see log:"; cat "$tunnel_log"; exit 1
fi

wss=$(printf '%s' "$url" | sed 's|^https://|wss://|')
echo ""
echo "✅ public relay is up."
echo ""
echo "   Relay URL (wss):  $wss"
echo ""
echo "   Make it the hosted default → put this ONE line in site/relay.txt:"
echo "       $wss"
echo "   then commit + push (GitHub Pages redeploys; all agents pick it up)."
echo ""
echo "   Keep this terminal open — closing it stops the relay + tunnel."
echo ""

wait "$RELAY_PID"
