#!/bin/sh

echo "================================================================"
echo "🚀 STARTING CONTAINER - RAILWAY COMPATIBLE"
echo "================================================================"

# Railway always injects PORT. Default only for local dev.
export PORT=${PORT:-3000}
# Allow configuring remote DeepSeek endpoint via env; default empty but explicit
export DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-}
export INTERFACE_HEARTBEAT_TIMEOUT_MS=${INTERFACE_HEARTBEAT_TIMEOUT_MS:-3000}
# Bind host (allow override for advanced setups)
export BIND_HOST=${BIND_HOST:-0.0.0.0}

echo "🚀 Starting API Server..."
echo "🌐 Listening on port: $PORT"
echo "🌐 Binding host: $BIND_HOST"
if [ -z "$DEEPSEEK_BASE_URL" ]; then
	echo "⚠️ DEEPSEEK_BASE_URL is not set — remote fallback will be disabled unless configured via env"
else
	echo "🌐 Remote DeepSeek configured: $DEEPSEEK_BASE_URL"
fi
echo "============================================================"

# IMPORTANT:
# - NO background processes
# - NO loops
# - NO traps
# - node must be PID 1

# Ensure script fails fast on errors
set -e

# Normalize line endings just in case (handles mounted files with CRLF)
if command -v sed >/dev/null 2>&1; then
	sed -i 's/\r$//' "$0" || true
fi

exec node index.js
