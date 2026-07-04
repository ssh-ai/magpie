# Magpie relay — self-host image.
#
# The relay brokers ciphertext only (never unseals), holds no state, and needs
# no config beyond a port. Build context is this `rust/` directory:
#
#   docker build -t magpie-relay rust/
#   docker run -p 8787:8787 magpie-relay
#
# Then point both agents' MCP at ws://<host>:8787 (or wss://… behind a TLS proxy).

# --- build stage: compile the relay inside the container (host toolchain irrelevant) ---
FROM rust:1-slim AS build
WORKDIR /build
COPY . .
RUN cargo build --release -p magpie-relay

# --- runtime stage: tiny image, non-root, just the binary ---
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 magpie
COPY --from=build /build/target/release/magpie-relay /usr/local/bin/magpie-relay
USER magpie
# Bind all interfaces so the container is reachable; override with env if needed.
ENV MAGPIE_RELAY_HOST=0.0.0.0 \
    MAGPIE_RELAY_PORT=8787
EXPOSE 8787
ENTRYPOINT ["magpie-relay"]
