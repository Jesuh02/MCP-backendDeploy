#!/bin/sh

echo "================================================================"
echo "🚀 STARTING CONTAINER - RAILWAY COMPATIBLE"
echo "================================================================"

# Railway always injects PORT. Default only for local dev.
export PORT=${PORT:-3000}

echo "🚀 Starting API Server..."
echo "🌐 Listening on port: $PORT"
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
