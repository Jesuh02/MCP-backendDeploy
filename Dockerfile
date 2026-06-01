# =============================================================================
# Stage 1 — Exportar el modelo de lengua de señas a ONNX con optimum.
# Se hace en una imagen Python descartable: el resultado (~95 MB) se copia al
# stage final, pero torch/optimum (~2 GB) NO viajan a producción.
# =============================================================================
FROM python:3.11-slim AS sign-language-builder

WORKDIR /build

# git es requerido por algunas dependencias de huggingface_hub al resolver
# repos; build-essential evita fallos al compilar wheels nativos en arm64.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential \
    && rm -rf /var/lib/apt/lists/*

# Instalar sólo lo necesario para `optimum.exporters.onnx`. Se fija torch CPU
# para evitar bajar wheels de CUDA (mucho más pesados).
RUN pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        "torch==2.4.1+cpu" \
    && pip install --no-cache-dir \
        "optimum[exporters]>=1.21,<2" \
        "transformers>=4.44,<5" \
        "onnx>=1.16" \
        "onnxruntime>=1.18"

# Sólo copiamos el script de conversión para maximizar el cache: este stage
# sólo se reconstruye si cambia el script.
COPY scripts/convert_sign_language_to_onnx.py scripts/convert_sign_language_to_onnx.py

RUN python scripts/convert_sign_language_to_onnx.py \
    && ls -lah models/sign-language models/sign-language/onnx

# =============================================================================
# Stage 2 — Imagen final de producción (Node 20 + FFmpeg).
# =============================================================================
FROM node:20-alpine

# Install FFmpeg for video processing
RUN apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev --legacy-peer-deps

# Copy source code
COPY . .

# Copiar el modelo ONNX generado en el stage de Python. Se hace después del
# `COPY . .` para que aunque el repo incluya un models/sign-language/ vacío,
# los artefactos del builder prevalezcan.
COPY --from=sign-language-builder /build/models/sign-language /app/models/sign-language

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
