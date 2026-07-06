#!/bin/sh
# Magpie public relay — one-command server setup (Ubuntu/Debian).
#
#   curl -fsSL https://ssh-ai.github.io/magpie/deploy-relay.sh | sh -s relay.example.com
#
# Given a domain whose DNS A/AAAA record points at this box, this installs:
#   - the magpie-relay binary (latest GitHub release) as a systemd service,
#     bound to localhost only,
#   - Caddy as a reverse proxy terminating TLS → the relay speaks wss://
#     to the world with an auto-renewed Let's Encrypt certificate.
#
# The relay brokers END-TO-END-ENCRYPTED ciphertext only: the operator of this
# box cannot read pairing codes or call contents.
set -eu

DOMAIN="${1:-${MAGPIE_RELAY_DOMAIN:-}}"
if [ -z "$DOMAIN" ]; then
  echo "usage: setup.sh <relay-domain>   (DNS for it must already point here)"
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo sh setup.sh $DOMAIN)"
  exit 1
fi

REPO="ssh-ai/magpie"
PORT=8787

# --- 1. relay binary ---------------------------------------------------------
arch=$(uname -m)
case "$arch" in
  x86_64|amd64)  target=linux-x64 ;;
  arm64|aarch64) target=linux-arm64 ;;
  *) echo "unsupported arch: $arch"; exit 1 ;;
esac

echo "→ installing magpie-relay ($target)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/$REPO/releases/latest/download/magpie-$target.tar.gz" \
  -o "$tmp/magpie.tar.gz"
tar -xzf "$tmp/magpie.tar.gz" -C "$tmp"
# mv (not in-place write) so re-running while the service holds the old binary works
chmod 0755 "$tmp/magpie-relay"
mv -f "$tmp/magpie-relay" /usr/local/bin/magpie-relay

# --- 2. systemd service (localhost-only; Caddy fronts the internet) ----------
id -u magpie >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin magpie

cat > /etc/systemd/system/magpie-relay.service <<EOF
[Unit]
Description=Magpie relay (ciphertext-only agent call broker)
After=network.target

[Service]
User=magpie
Environment=MAGPIE_RELAY_HOST=127.0.0.1
Environment=MAGPIE_RELAY_PORT=$PORT
ExecStart=/usr/local/bin/magpie-relay
Restart=always
RestartSec=2
# The relay needs nothing from the system: lock it down.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now magpie-relay
echo "→ magpie-relay running on 127.0.0.1:$PORT"

# --- 3. Caddy: wss:// with automatic TLS --------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "→ installing caddy"
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF

systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo ""
echo "✅ relay is up."
echo ""
echo "   Relay URL:  wss://$DOMAIN"
echo ""
echo "   Point agents at it:  MAGPIE_RELAY_URL=wss://$DOMAIN"
echo "   Health checks:       systemctl status magpie-relay caddy"
echo "                        curl -si https://$DOMAIN | head -1   (any HTTP reply = TLS front up)"
