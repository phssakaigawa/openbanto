# syntax=docker/dockerfile:1
#
# OpenBanto base image (MIT-clean, engine-agnostic).
#
# The LLM engine (IBM Bob by default) is NOT baked in — Bob is IBM proprietary,
# so bundling it would mean redistributing IBM software. Instead the entrypoint
# bootstraps the configured engine at first run into the persistent home volume
# (idempotent + offline-tolerant). See docker-entrypoint.sh.
#
# Build:  docker build -t ghcr.io/phssakaigawa/openbanto:base-dev .
# Run:    docker run --rm -p 7777:7777 -e BOB_API_KEY=... -e SLACK_APP_TOKEN=... \
#           -e SLACK_BOT_TOKEN=... -v openbanto-home:/home/openbanto/.openbanto \
#           ghcr.io/phssakaigawa/openbanto:base-dev

############################ builder ############################
FROM node:22-bookworm-slim AS builder

# Native-module toolchain (better-sqlite3, node-pty, classic-level). glibc base
# (bookworm-slim) avoids the musl build pain of Alpine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

COPY . .
RUN corepack pnpm@10.6.4 install --frozen-lockfile \
 && corepack pnpm@10.6.4 build

############################ runtime ############################
FROM node:22-bookworm-slim AS runtime

# npm is used by the entrypoint to install the engine into the volume.
RUN corepack enable \
 && useradd -m -u 10001 openbanto

WORKDIR /app
COPY --from=builder --chown=openbanto:openbanto /app /app
COPY --chown=openbanto:openbanto docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER openbanto
ENV OPENBANTO_HOME=/home/openbanto/.openbanto \
    PATH=/home/openbanto/.openbanto/engines/bin:/usr/local/bin:/usr/bin:/bin

EXPOSE 7777
# Persist config, sessions DB, knowledge, cron, and the installed engine here.
VOLUME ["/home/openbanto/.openbanto"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
