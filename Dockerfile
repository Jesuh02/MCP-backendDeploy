FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose MCP HTTP port (Railway will bind to PORT 3000)
EXPOSE 3000

# Health check - MCP server runs on port 3000
# Railway healthcheck uses /health by default
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start MCP HTTP server only (NOT index.js)
CMD ["node", "src/mcp-http.js"]
