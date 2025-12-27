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

# Expose main port (Railway will use PORT env variable)
EXPOSE 3000 3001

# Health check - Use /health endpoint with longer start period for Railway
# Railway healthcheck uses /health by default
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=10 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-3000}/health || exit 1

# Make start script executable
RUN chmod +x start.sh

# Start server (Run both API and MCP servers)
CMD ["sh", "start.sh"]
