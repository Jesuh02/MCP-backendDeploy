#!/bin/sh

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

echo "Starting index.js (API Server on port $PORT)..."
# Run in a loop to restart on failure
while true; do
    node index.js
    echo "⚠️ API Server crashed. Restarting in 5 seconds..."
    sleep 5
done &
API_PID=$!

echo "Starting mcp-http.js (MCP Server on port $MCP_HTTP_PORT)..."
# Run in a loop to restart on failure
while true; do
    node src/mcp-http.js
    echo "⚠️ MCP Server crashed. Restarting in 5 seconds..."
    sleep 5
done &
MCP_PID=$!

echo "Both servers started. API PID: $API_PID, MCP PID: $MCP_PID"

# Keep the script running to prevent container exit
# We wait for the background shells, which are infinite loops
wait $API_PID $MCP_PID
