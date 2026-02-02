/**
 * EmbeddingService - SOLID: Single Responsibility Principle
 * This service is ONLY responsible for generating text embeddings.
 * It abstracts the embedding provider (OpenAI, DeepSeek, Ollama).
 */

import { IEmbeddingProvider } from '../../domain/interfaces/IEmbeddingProvider.js';

// Custom OpenRouter Embeddings implementation using native fetch
// This bypasses LangChain to ensure compatibility with specific OpenRouter headers/models
class OpenRouterGenericEmbeddings {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.modelName = config.modelName || "qwen/qwen3-embedding-8b";
        this.siteUrl = config.siteUrl || "https://github.com/Startups-M/tareamov-mcp-server";
        this.siteName = config.siteName || "TaskMov MCP";
    }

    async embedQuery(text) {
        return this._callApi(text);
    }

    async embedDocuments(texts) {
        return this._callApi(texts);
    }

    async _callApi(input) {
        const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": this.siteUrl,
                "X-Title": this.siteName,
            },
            body: JSON.stringify({
                "model": this.modelName,
                "input": input,
                "encoding_format": "float"
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} ${errText}`);
        }

        const data = await response.json();

        // Handle standard OpenAI-compatiable format: { data: [{ embedding: [...] }] }
        if (data.data) {
            if (Array.isArray(input)) {
                return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
            } else {
                return data.data[0].embedding;
            }
        }

        throw new Error('Invalid response format from OpenRouter');
    }
}

// Dynamic imports to handle missing dependencies gracefully
let OpenAIEmbeddings = null;
let OllamaEmbeddings = null;

try {
    const openaiModule = await
    import ("@langchain/openai");
    OpenAIEmbeddings = openaiModule.OpenAIEmbeddings;
} catch (e) {
    console.warn("⚠️ @langchain/openai not available for embeddings");
}

try {
    const ollamaModule = await
    import ("@langchain/community/embeddings/ollama");
    OllamaEmbeddings = ollamaModule.OllamaEmbeddings;
} catch (e) {
    console.warn("⚠️ @langchain/community not available for Ollama embeddings");
}

export class EmbeddingService extends IEmbeddingProvider {
    static instance = null;

    static getInstance() {
        if (!EmbeddingService.instance) {
            EmbeddingService.instance = new EmbeddingService();
        }
        return EmbeddingService.instance;
    }

    constructor() {
        super();
        if (EmbeddingService.instance) return EmbeddingService.instance;

        this.model = null;
        this.provider = 'none';
        this.dimensions = 1536; // Default for OpenAI text-embedding-3-small

        this._initializeProvider();
    }

    _initializeProvider() {
        const openRouterApiKey = process.env.OPENROUTER_API_KEY;
        const openAiApiKey = process.env.OPENAI_API_KEY;
        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;

        // Priority 1: OpenRouter (User Preference with direct fetch)
        if (openRouterApiKey) {
            console.log("🔗 Initializing OpenRouter Embeddings...");
            try {
                // Use a standard, widely accessible model as default to avoid invalid model ID errors.
                // Qwen/qwen3-embedding-8b is not reliably hosted on OpenRouter.
                // We use openai/text-embedding-3-small via OpenRouter which is reliable and standard.
                const userModel = process.env.OPENROUTER_EMBEDDING_MODEL;
                let modelToUse = userModel || "openai/text-embedding-3-small";

                // Sanity check: If user provided the incorrect Qwen identifier (Qwen3-VL-Embedding-8B)
                // Correct it to the valid OpenRouter ID: qwen/qwen3-embedding-8b
                if (modelToUse === "Qwen3-VL-Embedding-8B" || modelToUse.toLowerCase().includes('qwen3-vl-embedding')) {
                    console.log(`⚠️ Auto-correcting invalid model ID '${modelToUse}' to 'qwen/qwen3-embedding-8b'`);
                    modelToUse = "qwen/qwen3-embedding-8b";
                }

                this.model = new OpenRouterGenericEmbeddings({
                    apiKey: openRouterApiKey,
                    modelName: modelToUse,
                    siteUrl: process.env.PUBLIC_URL,
                    siteName: "TaskMov MCP Server"
                });
                this.provider = 'openrouter';

                // Determine dimensions based on model
                if (modelToUse.includes('openai') || modelToUse.includes('text-embedding-3')) {
                    this.dimensions = 1536;
                } else if (modelToUse.includes('qwen')) {
                    this.dimensions = 4096;
                } else {
                    this.dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || '1536');
                }

                console.log(`✅ OpenRouter Embeddings initialized (Model: ${this.model.modelName}, Dimensions: ${this.dimensions})`);
                return;
            } catch (e) {
                console.warn("⚠️ OpenRouter embeddings failed initialization:", e.message);
            }
        }

        // Priority 2: OpenAI (best for embeddings)
        if (openAiApiKey && OpenAIEmbeddings) {
            console.log("🔗 Initializing OpenAI Embeddings (text-embedding-3-small)...");
            this.model = new OpenAIEmbeddings({
                openAIApiKey: openAiApiKey,
                modelName: "text-embedding-3-small",
                dimensions: 1536
            });
            this.provider = 'openai';
            this.dimensions = 1536;
            console.log("✅ OpenAI Embeddings initialized");
            return;
        }

        // Priority 2: DeepSeek (Standard OpenAI-compatible endpoint)
        if (deepSeekApiKey && OpenAIEmbeddings) {
            console.log("🔗 Initializing DeepSeek Embeddings...");
            try {
                // FIXED: Handle potential Qwen model error by defaulting to deepseek-embedding-v2
                // if env var contains invalid Qwen string, ignore it
                let modelID = process.env.DEEPSEEK_EMBEDDING_MODEL || "deepseek-embedding-v2";
                if (modelID.includes('Qwen') || modelID.includes('VL')) {
                    console.warn(`⚠️ Invalid model ID detected in env: ${modelID}. Fallback to deepseek-embedding-v2`);
                    modelID = "deepseek-embedding-v2";
                }

                this.model = new OpenAIEmbeddings({
                    openAIApiKey: deepSeekApiKey,
                    configuration: {
                        baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
                    },
                    modelName: modelID,
                });
                this.provider = 'deepseek';
                this.dimensions = 1024; // DeepSeek embedding v2 typical dimension (verify if needed)
                console.log(`✅ DeepSeek Embeddings initialized (Model: ${this.model.modelName})`);
                return;
            } catch (e) {
                console.warn("⚠️ DeepSeek embeddings failed, trying fallback...", e.message);
            }
        }

        // Priority 3: Ollama (local, free)
        if (OllamaEmbeddings) {
            console.log("🔗 Initializing Ollama Embeddings (nomic-embed-text)...");
            try {
                this.model = new OllamaEmbeddings({
                    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                    model: "nomic-embed-text"
                });
                this.provider = 'ollama';
                this.dimensions = 768; // nomic-embed-text dimensions
                console.log("✅ Ollama Embeddings initialized");
                return;
            } catch (e) {
                console.warn("⚠️ Ollama embeddings failed:", e.message);
            }
        }

        // Priority 4: Simple hash-based embeddings (fallback, no external dependency)
        console.warn("⚠️ No embedding provider available, using simple hash-based fallback");
        this.provider = 'fallback';
        this.dimensions = 384;
    }

    /**
     * Generate embedding for a single text query
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} - Embedding vector
     */
    async embedQuery(text) {
        if (!text || typeof text !== 'string') {
            throw new Error('Text must be a non-empty string');
        }

        if (this.provider === 'fallback') {
            return this._fallbackEmbed(text);
        }

        if (!this.model) {
            throw new Error('Embedding model not initialized');
        }

        try {
            const embedding = await this.model.embedQuery(text);
            return embedding;
        } catch (error) {
            console.error(`❌ Embedding error (${this.provider}): ${error.message}`);
            // Check for specific API errors we can handle
            if (this.provider === 'deepseek' && (error.message.includes('400') || error.message.includes('404'))) {
                console.warn("⚠️ DeepSeek API rejected request, attempting fallback hash embedding to prevent crash");
                return this._fallbackEmbed(text);
            }
            // Fallback to simple hash if provider fails
            return this._fallbackEmbed(text);
        }
    }

    /**
     * Generate embeddings for multiple texts (batch)
     * @param {string[]} texts - Array of texts to embed
     * @returns {Promise<number[][]>} - Array of embedding vectors
     */
    async embedDocuments(texts) {
        if (!Array.isArray(texts) || texts.length === 0) {
            throw new Error('Texts must be a non-empty array');
        }

        if (this.provider === 'fallback') {
            return texts.map(t => this._fallbackEmbed(t));
        }

        if (!this.model) {
            throw new Error('Embedding model not initialized');
        }

        try {
            const embeddings = await this.model.embedDocuments(texts);
            return embeddings;
        } catch (error) {
            console.error(`❌ Batch embedding error (${this.provider}):`, error.message);
            // Fallback to simple hash if provider fails
            return texts.map(t => this._fallbackEmbed(t));
        }
    }

    /**
     * Simple hash-based embedding fallback
     * Uses character-level hashing to create a pseudo-embedding
     * NOT suitable for production semantic search, but prevents crashes
     * @param {string} text - Text to embed
     * @returns {number[]} - Pseudo-embedding vector
     */
    _fallbackEmbed(text) {
        const dimensions = this.dimensions;
        const embedding = new Array(dimensions).fill(0);

        // Simple hash distribution
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);
            const idx = (charCode * (i + 1)) % dimensions;
            embedding[idx] += charCode / 1000;
        }

        // Normalize
        const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0)) || 1;
        return embedding.map(val => val / magnitude);
    }

    /**
     * Get the current provider name
     * @returns {string} Provider name
     */
    getProvider() {
        return this.provider;
    }

    /**
     * Get embedding dimensions
     * @returns {number} Dimensions
     */
    getDimensions() {
        return this.dimensions;
    }

    /**
     * Check if service is ready
     * @returns {boolean}
     */
    isReady() {
        return this.provider !== 'none';
    }
}

export default EmbeddingService;