#!/bin/sh

# Start both servers in parallel
# index.js runs on PORT (3001 default)
# mcp-http.js runs on MCP_HTTP_PORT (3000 default)

# Force ports to avoid conflicts
export PORT=3001
export MCP_HTTP_PORT=3000

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
