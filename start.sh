#!/bin/sh

# Start both servers in parallel
# index.js runs on PORT (3001 default)
# mcp-http.js runs on MCP_HTTP_PORT (3000 default)

echo "Starting index.js (API Server on port ${PORT:-3001})..."

# REMOVED bootstrap-health.js because it causes EADDRINUSE conflict
# Try to start bootstrap health server in background. Non-fatal if it fails (EADDRINUSE).
echo "Attempting to start bootstrap health server..." | tee -a logs/start.log
node bootstrap-health.js >> logs/bootstrap.log 2>&1 &
BOOT_PID=$!

sleep 1

if ps -p $BOOT_PID > /dev/null 2>&1; then
	echo "Bootstrap health server started (PID: $BOOT_PID)" | tee -a logs/start.log
else
	echo "Bootstrap health server did not start (possible EADDRINUSE). Continuing without bootstrap." | tee -a logs/start.log
fi

node index.js >> logs/index.log 2>&1 &
API_PID=$!

echo "Starting mcp-http.js (MCP Server on port ${MCP_HTTP_PORT:-3000})..."
node src/mcp-http.js &
MCP_PID=$!

echo "Both servers started. API PID: $API_PID, MCP PID: $MCP_PID"

# Wait for both processes - if either dies, the container will exit
wait $API_PID $MCP_PID
