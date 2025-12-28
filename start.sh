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
exec node index.js
