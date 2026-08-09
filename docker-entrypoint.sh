#!/bin/sh
# OpenBanto container entrypoint.
#   1) render ~/.openbanto/config.yaml from environment variables (secrets)
#   2) bootstrap the LLM engine (default: IBM Bob) — idempotent, into the
#      persistent home volume, tolerant of offline/air-gapped environments
#   3) start the gateway daemon
set -e

: "${OPENBANTO_HOME:=$HOME/.openbanto}"
mkdir -p "$OPENBANTO_HOME"
CONFIG="$OPENBANTO_HOME/config.yaml"

# ---- 1) config.yaml from env (only when absent, or CONFIG_RENDER=force) ------
# Slack tokens are rendered verbatim; if either is empty the Slack connector
# simply stays off (server.ts requires both appToken and botToken).
if [ ! -f "$CONFIG" ] || [ "${CONFIG_RENDER:-auto}" = "force" ]; then
  echo "[entrypoint] rendering $CONFIG from environment"
  cat > "$CONFIG" <<YAML
jinn:
  version: "2026.8.6"
gateway:
  port: ${GATEWAY_PORT:-7777}
  host: "${GATEWAY_HOST:-0.0.0.0}"
engines:
  default: ${ENGINE_DEFAULT:-bob}
  bob:
    bin: bob
  claude:
    bin: claude
    model: claude-opus-5
  codex:
    bin: codex
    model: gpt-5.6-sol
connectors:
  slack:
    appToken: "${SLACK_APP_TOKEN:-}"
    botToken: "${SLACK_BOT_TOKEN:-}"
portal:
  portalName: "${PORTAL_NAME:-Banto}"
  language: ${PORTAL_LANGUAGE:-Japanese}
  onboarded: ${PORTAL_ONBOARDED:-false}
logging:
  file: false
  stdout: true
  level: ${LOG_LEVEL:-info}
sessions:
  rateLimitStrategy: ${RATE_LIMIT_STRATEGY:-wait}
YAML
  chmod 600 "$CONFIG"
fi

# ---- 2) engine bootstrap (idempotent / on the volume / offline-tolerant) -----
# Bob is installed into $OPENBANTO_HOME/engines (persisted), so it is fetched
# only on first run. Set ENGINE_INSTALL=off to skip (air-gapped / pre-staged).
if [ "${ENGINE_INSTALL:-auto}" != "off" ] \
   && [ "${ENGINE_DEFAULT:-bob}" = "bob" ] \
   && ! command -v bob >/dev/null 2>&1; then
  echo "[entrypoint] installing bobshell@${BOB_VERSION:-latest} into $OPENBANTO_HOME/engines ..."
  npm install -g "bobshell@${BOB_VERSION:-latest}" --prefix "$OPENBANTO_HOME/engines" \
    || echo "[entrypoint] WARN: bob install failed (offline? pre-stage bob or set ENGINE_INSTALL=off)"
fi
export PATH="$OPENBANTO_HOME/engines/bin:$PATH"

# ---- 3) start ---------------------------------------------------------------
echo "[entrypoint] starting OpenBanto gateway (engine=${ENGINE_DEFAULT:-bob}, home=$OPENBANTO_HOME)"
exec node /app/packages/jimmy/dist/bin/jimmy.js start
