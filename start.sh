#!/bin/sh

echo "================================================================"
echo "🚀 STARTING CONTAINER - VERSION: INDESTRUCTIBLE V4 (MONITOR)"
echo "================================================================"

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

# Function to handle signals
cleanup() {
    echo "🛑 Received signal (SIGINT/SIGTERM). Ignoring to keep container alive..."
}

# Trap signals
trap 'cleanup' SIGINT SIGTERM

# Start API Server
echo "🔄 Starting API Server..."
node index.js &
API_PID=$!

# Start MCP Server
echo "🔄 Starting MCP Server..."
node src/mcp-http.js &
MCP_PID=$!

echo "✅ Services started. API_PID: $API_PID, MCP_PID: $MCP_PID"

# Monitor loop
while true; do
    # Check API Server
    if ! kill -0 $API_PID 2>/dev/null; then
        echo "⚠️ API Server (PID $API_PID) crashed. Restarting..."
        node index.js &
        API_PID=$!
        echo "✅ API Server restarted with PID $API_PID"
    fi

    # Check MCP Server
    if ! kill -0 $MCP_PID 2>/dev/null; then
        echo "⚠️ MCP Server (PID $MCP_PID) crashed. Restarting..."
        node src/mcp-http.js &
        MCP_PID=$!
        echo "✅ MCP Server restarted with PID $MCP_PID"
    fi

    # Heartbeat every 60 seconds
    # We use a counter to avoid spamming logs
    current_time=$(date +%s)
    if [ $((current_time % 60)) -eq 0 ]; then
        echo "💓 Heartbeat: System healthy. API: $API_PID, MCP: $MCP_PID"
    fi

    sleep 5
done
