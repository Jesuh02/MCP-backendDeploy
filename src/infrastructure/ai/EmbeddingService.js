/**
 * EmbeddingService - SOLID: Single Responsibility Principle
 * This service is ONLY responsible for generating text embeddings.
 * It abstracts the embedding provider (OpenAI, DeepSeek, Ollama).
 */

import { IEmbeddingProvider } from '../../domain/interfaces/IEmbeddingProvider.js';

// Dynamic imports to handle missing dependencies gracefully
let OpenAIEmbeddings = null;
let OllamaEmbeddings = null;

try {
    const openaiModule = await import("@langchain/openai");
    OpenAIEmbeddings = openaiModule.OpenAIEmbeddings;
} catch (e) {
    console.warn("⚠️ @langchain/openai not available for embeddings");
}

try {
    const ollamaModule = await import("@langchain/community/embeddings/ollama");
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
        const openAiApiKey = process.env.OPENAI_API_KEY;
        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        
        // Priority 1: OpenAI (best for embeddings)
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
        
        // Priority 2: DeepSeek (if they support embeddings)
        if (deepSeekApiKey && OpenAIEmbeddings) {
            console.log("🔗 Initializing DeepSeek Embeddings...");
            try {
                this.model = new OpenAIEmbeddings({
                    openAIApiKey: deepSeekApiKey,
                    configuration: {
                        baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
                    },
                    modelName: "deepseek-chat", // DeepSeek might not have dedicated embeddings
                });
                this.provider = 'deepseek';
                console.log("✅ DeepSeek Embeddings initialized (experimental)");
                return;
            } catch (e) {
                console.warn("⚠️ DeepSeek embeddings failed, trying fallback...");
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
            console.error(`❌ Embedding error (${this.provider}):`, error.message);
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

