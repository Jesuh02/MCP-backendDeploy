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
EXPOSE 3000

# Health check - Use /health endpoint with longer start period for Railway
# Railway healthcheck uses /health by default
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health || exit 1

# Start server
CMD ["npm", "start"]
