#!/bin/sh

# Start both servers in parallel
# index.js runs on PORT (3001 default)
# mcp-http.js runs on MCP_HTTP_PORT (3000 default)

set -x

# Defensive: ensure logs directory exists
mkdir -p logs

echo "Starting startup sequence" | tee -a logs/start.log

# Log environment info for debugging
echo "DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> logs/start.log
echo "PATH=$PATH" >> logs/start.log
node -v >> logs/start.log 2>&1 || echo "node not found" >> logs/start.log

echo "Attempting to start bootstrap health server..." | tee -a logs/start.log
node bootstrap-health.js >> logs/bootstrap.log 2>&1 &
BOOT_PID=$!

sleep 1

if ps -p $BOOT_PID > /dev/null 2>&1; then
	echo "Bootstrap health server started (PID: $BOOT_PID)" | tee -a logs/start.log
else
	echo "Bootstrap health server did not start (possible EADDRINUSE). Continuing without bootstrap." | tee -a logs/start.log
fi

echo "Starting index.js (API Server on port ${PORT:-3001})..." | tee -a logs/start.log
node index.js >> logs/index.log 2>&1 &
API_PID=$!

echo "Starting mcp-http.js (MCP Server on port ${MCP_HTTP_PORT:-3000})..." | tee -a logs/start.log
node src/mcp-http.js >> logs/mcp-http.log 2>&1 &
MCP_PID=$!

echo "Both servers started. API PID: $API_PID, MCP PID: $MCP_PID" | tee -a logs/start.log

# Wait for both processes - if either dies, the container will exit
wait $API_PID $MCP_PID
