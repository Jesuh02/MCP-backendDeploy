FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy source code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Disable Dockerfile HEALTHCHECK to let Railway handle it via UI configuration
# HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=10 \
#   CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/health || exit 1

# Make start script executable and fix CRLF line endings (Windows compatibility)
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

# Force cache bust for start.sh updates
ENV START_SCRIPT_VERSION=v6

# Start the application directly with node to ensure PID 1 and signal handling
CMD ["node", "index.js"]
