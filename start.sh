#!/bin/sh

# Start both servers in parallel
# index.js runs on PORT (3001 default)
# mcp-http.js runs on MCP_HTTP_PORT (3000 default)

echo "Starting index.js (API Server on port ${PORT:-3001})..."
node index.js &
API_PID=$!

echo "Starting mcp-http.js (MCP Server on port ${MCP_HTTP_PORT:-3000})..."
node src/mcp-http.js &
MCP_PID=$!

echo "Both servers started. API PID: $API_PID, MCP PID: $MCP_PID"

# Wait for both processes - if either dies, the container will exit
wait $API_PID $MCP_PID
