FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install curl for healthcheck (alpine doesn't have wget)
RUN apk add --no-cache curl

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
# Use curl instead of wget (alpine compatible)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start MCP HTTP server only (NOT index.js)
CMD ["node", "src/mcp-http.js"]
