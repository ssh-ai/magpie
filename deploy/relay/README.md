# Deploying a public Magpie relay

The relay is the one internet-facing component. It brokers **end-to-end-encrypted
ciphertext only** — the box operator cannot read pairing codes or call contents —
and it is DoS-hardened (connection/IP caps, per-connection rate limit, bounded
queues, 2 MiB frame cap, pending/call caps).

## What you need

1. A small VPS (any $4–5/mo box is far more than enough — the relay forwards a
   few KB per LLM turn and idles between them). Ubuntu/Debian, ports 80/443 open.
2. A domain (or subdomain) with an A/AAAA record pointing at the box,
   e.g. `relay.example.com`.

## One command

```bash
curl -fsSL https://ssh-ai.github.io/magpie/deploy-relay.sh | sudo sh -s relay.example.com
```

This installs the latest `magpie-relay` release as a locked-down systemd service
(localhost-only) and Caddy as a TLS front — Let's Encrypt certificates are
issued and renewed automatically. The relay is then reachable at:

```
wss://relay.example.com
```

## Operations

```bash
systemctl status magpie-relay caddy    # health
journalctl -u magpie-relay -f          # relay logs (connection events only)
```

Upgrading: re-run the setup command — it re-downloads the latest release and
restarts the service.
