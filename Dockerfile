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

# NOTE: Railway has its own health check system (railway.json)
# Docker HEALTHCHECK is disabled to avoid conflicts

# Start MCP HTTP server only (NOT index.js)
CMD ["node", "src/mcp-http.js"]
