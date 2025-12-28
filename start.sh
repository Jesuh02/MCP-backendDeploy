#!/bin/sh

echo "================================================================"
echo "🚀 STARTING CONTAINER - ROBUST MODE"
echo "================================================================"

# Respect existing PORT (Railway) or default to 3001
export PORT=${PORT:-3001}

echo "🚀 Starting Services..."
echo "   • API Server (index.js) on port $PORT"

# Start API Server Loop (Main Service)
# This ensures that if the server crashes (e.g. EADDRINUSE), it restarts
while true; do
    echo "🔄 Starting API Server (index.js)..."
    node index.js
    EXIT_CODE=$?
    echo "⚠️ API Server crashed with exit code $EXIT_CODE. Restarting in 2 seconds..."
    sleep 2
done
