#!/bin/sh

echo "================================================================"
echo "🚀 STARTING CONTAINER - VERSION: INDESTRUCTIBLE V3 (CRLF FIXED)"
echo "================================================================"

# Start both servers in parallel
# index.js runs on PORT (defaults to 3001 if not set)
# mcp-http.js runs on MCP_HTTP_PORT (defaults to 3000 if not set)

# Respect existing PORT (Railway) or default to 3001
export PORT=${PORT:-3001}

# Set MCP port. Default to 3000.
# If PORT is 3000, shift MCP port to 3001 to avoid conflict.
if [ "$PORT" = "3000" ]; then
    export MCP_HTTP_PORT=3001
else
    export MCP_HTTP_PORT=${MCP_HTTP_PORT:-3000}
fi

echo "🚀 Starting Services..."
echo "   • API Server (index.js) on port $PORT"
echo "   • MCP Server (mcp-http.js) on port $MCP_HTTP_PORT"

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

# MCP Server (mcp-http.js) is DISABLED to prevent conflicts and resource usage.
# index.js now handles all routes including MCP and /procesar-prompt.
echo "ℹ️  MCP Server (mcp-http.js) skipped. Using index.js as single entry point."
MCP_PID=0

echo "✅ Server started in background. API_PID: $API_PID"

echo "✅ Both servers started in background. API_PID: $API_PID, MCP_PID: $MCP_PID"

# Trap signals to kill child processes gracefully
# We use || true to suppress errors if processes are already dead
# MODIFIED: Do NOT exit on signal. Just log it. This keeps the container alive for debugging.
trap 'echo "🛑 Received signal (SIGINT/SIGTERM). Ignoring to keep container alive..."' SIGINT SIGTERM

# Keep script running forever using a robust loop
# This prevents the container from exiting even if child processes crash/restart
echo "✅ Container startup complete. Entering keep-alive loop."
while true; do
    # Sleep for a long time, but not forever so we can catch signals
    sleep 10
    echo "💓 Heartbeat: Container is still alive..."
done
