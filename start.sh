#!/bin/sh

echo "================================================================"
echo "🚀 STARTING CONTAINER - VERSION: ROBUST & SILENT"
echo "================================================================"

# Respect existing PORT (Railway) or default to 3001
export PORT=${PORT:-3001}

echo "🚀 Starting Services..."
echo "   • API Server (index.js) on port $PORT"

# Start API Server Loop (Main Service)
(
    while true; do
        echo "🔄 Starting API Server (index.js)..."
        node index.js
        EXIT_CODE=$?
        echo "⚠️ API Server crashed with exit code $EXIT_CODE. Restarting in 1 second..."
        sleep 1
    done
) &
API_PID=$!

echo "✅ Server started in background. API_PID: $API_PID"

# Trap signals to keep container alive
trap 'echo "🛑 Received signal. Ignoring to keep container alive..."' SIGINT SIGTERM

# Keep script running forever (Silent Heartbeat)
while true; do
    sleep 60
done
