# =============================================================================
# Production image (Node 20 + FFmpeg)
#
# Do not export the sign-language ONNX model during Docker builds. The PyTorch
# download/export step can exceed Railway's build deadline. If static letter
# classification is needed in production, provide one of these:
#   - prebuilt files in models/sign-language/
#   - SIGN_LANGUAGE_HF_REPO pointing to a Hugging Face repo with the ONNX files
# Dynamic word/phrase recognition continues to use the VLM runtime path.
# =============================================================================
FROM node:20-slim

# Install FFmpeg for video processing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --legacy-peer-deps

COPY . .

RUN mkdir -p logs

# Disable Dockerfile HEALTHCHECK to let Railway handle it via UI configuration.
# HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=10 \
#   CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/health || exit 1

# Make start script executable and fix CRLF line endings (Windows compatibility).
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

ENV START_SCRIPT_VERSION=v7

CMD ["node", "index.js"]
