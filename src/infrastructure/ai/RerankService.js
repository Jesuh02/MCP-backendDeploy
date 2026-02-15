/**
 * RerankService — Professional-grade semantic reranking for RAG chunks.
 *
 * SOLID Principles:
 * - S: Única responsabilidad → reordenar chunks por relevancia SEMÁNTICA real.
 * - O: Abierto a extensión → proveedores se añaden sin modificar lógica existente.
 * - L: Sustituible → implementa IRerankProvider.
 * - I: Interfaz segregada → solo expone rerank() e isAvailable().
 * - D: Inversión de dependencias → el dominio depende de la abstracción.
 *
 * ═══════════════════════════════════════════════════════════════════
 * RERANKING PROVIDER CASCADE (por prioridad):
 * ═══════════════════════════════════════════════════════════════════
 *
 * 1. Cohere Rerank v3.5    — cross-encoder neural (COHERE_API_KEY)
 * 2. Jina Reranker v2      — cross-encoder neural (JINA_API_KEY)
 * 3. Voyage AI Reranker    — cross-encoder neural (VOYAGE_API_KEY)
 * 4. Embedding Semantic     — bi-encoder via EmbeddingService (FREE, uses existing infra)
 * 5. TF-IDF + BM25 hybrid  — keyword-based fallback (FREE, zero latency)
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY SEMANTIC > KEYWORD?
 * ═══════════════════════════════════════════════════════════════════
 *
 *   Query:        "mitosis en plantas"
 *   Chunk A:      "división celular en organismos vegetales"
 *   Chunk B:      "la mitosis es un proceso importante"
 *
 *   TF-IDF/BM25:  B wins (keyword match "mitosis")
 *   Cross-encoder: A wins (understands semantic equivalence)
 *   Embedding:     A wins (vectors are semantically close)
 *
 * The cascade ensures we always use the BEST available method.
 *
 * Env vars:
 *   RERANK_ENABLED   — 'true' (default) | 'false'
 *   RERANK_METHOD    — 'auto' | 'cohere' | 'jina' | 'voyage' | 'embedding' | 'tfidf'
 *   COHERE_API_KEY   — enables Cohere cross-encoder
 *   JINA_API_KEY     — enables Jina cross-encoder
 *   VOYAGE_API_KEY   — enables Voyage AI cross-encoder
 */

import { IRerankProvider } from '../../domain/interfaces/IRerankProvider.js';
import { logger } from '../logging/Logger.js';

// ────────────────────────────────────────────────────────────────────
// Tokenization utilities for TF-IDF / BM25 fallback
// ────────────────────────────────────────────────────────────────────

/** Stop-words en español e inglés (las más comunes). */
const STOP_WORDS = new Set([
    // Español
    'de', 'la', 'el', 'en', 'y', 'los', 'del', 'las', 'un', 'por', 'con',
    'una', 'su', 'para', 'es', 'al', 'lo', 'como', 'más', 'pero', 'sus',
    'le', 'ya', 'o', 'fue', 'este', 'ha', 'si', 'porque', 'esta', 'son',
    'entre', 'cuando', 'muy', 'sin', 'sobre', 'ser', 'también', 'me', 'hasta',
    'hay', 'donde', 'quien', 'desde', 'nos', 'durante', 'uno', 'ni', 'que',
    'se', 'no', 'a', 'e', 'i',
    // English
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
    'in', 'with', 'to', 'for', 'of', 'not', 'no', 'it', 'be', 'was',
    'are', 'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you',
    'his', 'her', 'its', 'our', 'your', 'their', 'my',
    'from', 'by', 'as', 'into', 'about', 'than', 'after', 'before',
]);

/**
 * Tokeniza texto: lowercase, elimina puntuación, filtra stop-words y tokens cortos.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    if (!text) return [];
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Calcula Term Frequency normalizada.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function computeTF(tokens) {
    const freq = new Map();
    for (const t of tokens) {
        freq.set(t, (freq.get(t) || 0) + 1);
    }
    const max = Math.max(...freq.values(), 1);
    const tf = new Map();
    for (const [term, count] of freq) {
        tf.set(term, count / max);
    }
    return tf;
}

/**
 * Calcula IDF sobre corpus.
 * @param {string[][]} corpus
 * @returns {Map<string, number>}
 */
function computeIDF(corpus) {
    const N = corpus.length;
    const docFreq = new Map();
    for (const tokens of corpus) {
        const unique = new Set(tokens);
        for (const t of unique) {
            docFreq.set(t, (docFreq.get(t) || 0) + 1);
        }
    }
    const idf = new Map();
    for (const [term, df] of docFreq) {
        idf.set(term, Math.log((N + 1) / (df + 0.5)) + 1);
    }
    return idf;
}

/**
 * BM25 score.
 * @param {string[]} queryTokens
 * @param {string[]} docTokens
 * @param {Map<string, number>} idf
 * @param {number} avgDL
 * @param {number} k1
 * @param {number} b
 * @returns {number}
 */
function bm25Score(queryTokens, docTokens, idf, avgDL, k1 = 1.5, b = 0.75) {
    const dl = docTokens.length;
    const freq = new Map();
    for (const t of docTokens) {
        freq.set(t, (freq.get(t) || 0) + 1);
    }
    let score = 0;
    for (const qt of queryTokens) {
        const f = freq.get(qt) || 0;
        const idfVal = idf.get(qt) || 0;
        const numerator = f * (k1 + 1);
        const denominator = f + k1 * (1 - b + b * (dl / avgDL));
        score += idfVal * (numerator / denominator);
    }
    return score;
}

/**
 * Cosine similarity between two float vectors (embedding arrays).
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} 0..1
 */
function cosineSimilarityVectors(vecA, vecB) {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
    const len = Math.min(vecA.length, vecB.length);
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}


// ────────────────────────────────────────────────────────────────────
// RerankService
// ────────────────────────────────────────────────────────────────────

export class RerankService extends IRerankProvider {
    /** @type {RerankService|null} */
    static _instance = null;

    constructor() {
        super();
        this._cohereApiKey = process.env.COHERE_API_KEY || null;
        this._jinaApiKey = process.env.JINA_API_KEY || null;
        this._voyageApiKey = process.env.VOYAGE_API_KEY || null;
        this._rerankEnabled = process.env.RERANK_ENABLED !== 'false';
        // 'auto' | 'cohere' | 'jina' | 'voyage' | 'embedding' | 'tfidf'
        this._preferredMethod = process.env.RERANK_METHOD || 'auto';
        this._embeddingService = null; // lazy-loaded
        this._providerStatus = {}; // track which providers succeeded/failed

        // Log available providers on construction
        const providers = [];
        if (this._cohereApiKey) providers.push('Cohere');
        if (this._jinaApiKey) providers.push('Jina');
        if (this._voyageApiKey) providers.push('Voyage');
        providers.push('Embedding-Semantic', 'TF-IDF+BM25');
        logger.info(`[RerankService] Available providers: [${providers.join(' → ')}] | Method: ${this._preferredMethod}`);
    }

    /**
     * Singleton factory.
     * @returns {RerankService}
     */
    static getInstance() {
        if (!RerankService._instance) {
            RerankService._instance = new RerankService();
        }
        return RerankService._instance;
    }

    /** @returns {boolean} */
    isAvailable() {
        return this._rerankEnabled;
    }

    // ════════════════════════════════════════════════════════════════
    // PUBLIC: rerank()
    // ════════════════════════════════════════════════════════════════

    /**
     * Rerank chunks by relevance to the query using the best available method.
     *
     * @param {string} query
     * @param {Array<{ content: string, fileName?: string, chunkIndex?: number }>} chunks
     * @param {{ topK?: number, topicName?: string, taskTitle?: string }} options
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array }>}
     */
    async rerank(query, chunks, options = {}) {
        if (!this._rerankEnabled || !chunks || chunks.length < 2) {
            return { reranked: false, method: 'none', chunks };
        }

        const { topK = chunks.length, topicName, taskTitle } = options;
        const enrichedQuery = this._buildEnrichedQuery(query, topicName, taskTitle);
        const startTime = Date.now();

        try {
            // ── Explicit method selection ──
            if (this._preferredMethod !== 'auto') {
                const result = await this._runSpecificMethod(this._preferredMethod, enrichedQuery, chunks, topK);
                if (result.reranked) {
                    this._logPerformance(result.method, chunks.length, startTime);
                    return result;
                }
                // If specified method fails, fall through to cascade
                logger.warn(`[RerankService] Preferred method '${this._preferredMethod}' failed, falling back to cascade`);
            }

            // ── Auto cascade: try each provider in priority order ──
            const cascade = [
                { name: 'cohere', fn: () => this._cohereRerank(enrichedQuery, chunks, topK), available: this._shouldUseCohere() },
                { name: 'jina', fn: () => this._jinaRerank(enrichedQuery, chunks, topK), available: this._shouldUseJina() },
                { name: 'voyage', fn: () => this._voyageRerank(enrichedQuery, chunks, topK), available: this._shouldUseVoyage() },
                { name: 'embedding', fn: () => this._embeddingSemanticRerank(enrichedQuery, chunks, topK), available: true },
                { name: 'tfidf', fn: () => this._tfidfBm25Rerank(enrichedQuery, chunks, topK), available: true },
            ];

            for (const provider of cascade) {
                if (!provider.available) continue;
                try {
                    const result = await provider.fn();
                    if (result.reranked) {
                        this._logPerformance(result.method, chunks.length, startTime);
                        this._providerStatus[provider.name] = 'ok';
                        return result;
                    }
                } catch (err) {
                    this._providerStatus[provider.name] = 'failed';
                    logger.warn(`[RerankService] ${provider.name} failed, trying next: ${err.message}`);
                }
            }

            // All providers failed — return unchanged
            return { reranked: false, method: 'none', chunks };

        } catch (err) {
            logger.error(`[RerankService] Reranking failed entirely: ${err.message}`);
            return { reranked: false, method: 'none', chunks };
        }
    }

    // ════════════════════════════════════════════════════════════════
    // PRIVATE: Method Router (for explicit selection)
    // ════════════════════════════════════════════════════════════════

    /**
     * Run a specific reranking method by name.
     * @param {string} method
     * @param {string} query
     * @param {Array} chunks
     * @param {number} topK
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array }>}
     */
    async _runSpecificMethod(method, query, chunks, topK) {
        switch (method) {
            case 'cohere': return this._cohereRerank(query, chunks, topK);
            case 'jina': return this._jinaRerank(query, chunks, topK);
            case 'voyage': return this._voyageRerank(query, chunks, topK);
            case 'embedding': return this._embeddingSemanticRerank(query, chunks, topK);
            case 'tfidf': return this._tfidfBm25Rerank(query, chunks, topK);
            default:
                logger.warn(`[RerankService] Unknown method '${method}', using auto cascade`);
                return { reranked: false, method: 'none', chunks };
        }
    }

    // ════════════════════════════════════════════════════════════════
    // PROVIDER 1: Cohere Rerank v3.5 (Cross-Encoder Neural)
    // ════════════════════════════════════════════════════════════════

    /** @returns {boolean} */
    _shouldUseCohere() {
        if (this._preferredMethod === 'tfidf' || this._preferredMethod === 'embedding') return false;
        return !!(this._cohereApiKey);
    }

    /**
     * Cross-encoder reranking via Cohere Rerank API.
     * Model: rerank-v3.5 (multilingual, 4096 token context)
     *
     * Cross-encoders process (query, document) pairs jointly through a transformer,
     * producing much more accurate relevance scores than bi-encoders or keyword methods.
     *
     * @param {string} query
     * @param {Array} chunks
     * @param {number} topK
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array }>}
     */
    async _cohereRerank(query, chunks, topK) {
        const documents = chunks.map(c => c.content || '');

        const response = await fetch('https://api.cohere.com/v2/rerank', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this._cohereApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'rerank-v3.5',
                query,
                documents,
                top_n: Math.min(topK, chunks.length),
                return_documents: false,
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Cohere API ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        if (!data.results || data.results.length === 0) {
            return { reranked: false, method: 'cohere', chunks };
        }

        const rerankedChunks = data.results
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .map(r => ({
                ...chunks[r.index],
                rerankScore: r.relevance_score,
                rerankProvider: 'cohere',
            }));

        logger.info(
            `[RerankService] ✅ Cohere cross-encoder reranked ${rerankedChunks.length} chunks. ` +
            `Top: ${rerankedChunks[0]?.rerankScore?.toFixed(4)}, ` +
            `Bottom: ${rerankedChunks[rerankedChunks.length - 1]?.rerankScore?.toFixed(4)}`
        );

        return { reranked: true, method: 'cohere-rerank-v3.5', chunks: rerankedChunks };
    }

    // ════════════════════════════════════════════════════════════════
    // PROVIDER 2: Jina Reranker v2 (Cross-Encoder Neural)
    // ════════════════════════════════════════════════════════════════

    /** @returns {boolean} */
    _shouldUseJina() {
        if (this._preferredMethod === 'tfidf' || this._preferredMethod === 'embedding') return false;
        return !!(this._jinaApiKey);
    }

    /**
     * Cross-encoder reranking via Jina Reranker API.
     * Model: jina-reranker-v2-base-multilingual (8192 token context, multilingual)
     *
     * Jina's cross-encoder is optimized for multilingual content and offers
     * a generous free tier (1M tokens/month), making it ideal for educational platforms.
     *
     * API: https://api.jina.ai/v1/rerank
     *
     * @param {string} query
     * @param {Array} chunks
     * @param {number} topK
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array }>}
     */
    async _jinaRerank(query, chunks, topK) {
        const documents = chunks.map(c => c.content || '');

        const response = await fetch('https://api.jina.ai/v1/rerank', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this._jinaApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'jina-reranker-v2-base-multilingual',
                query,
                documents,
                top_n: Math.min(topK, chunks.length),
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Jina API ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        if (!data.results || data.results.length === 0) {
            return { reranked: false, method: 'jina', chunks };
        }

        const rerankedChunks = data.results
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .map(r => ({
                ...chunks[r.index],
                rerankScore: r.relevance_score,
                rerankProvider: 'jina',
            }));

        logger.info(
            `[RerankService] ✅ Jina cross-encoder reranked ${rerankedChunks.length} chunks. ` +
            `Top: ${rerankedChunks[0]?.rerankScore?.toFixed(4)}, ` +
            `Bottom: ${rerankedChunks[rerankedChunks.length - 1]?.rerankScore?.toFixed(4)}`
        );

        return { reranked: true, method: 'jina-reranker-v2-multilingual', chunks: rerankedChunks };
    }

    // ════════════════════════════════════════════════════════════════
    // PROVIDER 3: Voyage AI Reranker (Cross-Encoder Neural)
    // ════════════════════════════════════════════════════════════════

    /** @returns {boolean} */
    _shouldUseVoyage() {
        if (this._preferredMethod === 'tfidf' || this._preferredMethod === 'embedding') return false;
        return !!(this._voyageApiKey);
    }

    /**
     * Cross-encoder reranking via Voyage AI Rerank API.
     * Model: rerank-2 (multilingual, high accuracy)
     *
     * @param {string} query
     * @param {Array} chunks
     * @param {number} topK
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array }>}
     */
    async _voyageRerank(query, chunks, topK) {
        const documents = chunks.map(c => c.content || '');

        const response = await fetch('https://api.voyageai.com/v1/rerank', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this._voyageApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'rerank-2',
                query,
                documents,
                top_k: Math.min(topK, chunks.length),
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Voyage API ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        if (!data.data || data.data.length === 0) {
            return { reranked: false, method: 'voyage', chunks };
        }

        const rerankedChunks = data.data
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .map(r => ({
                ...chunks[r.index],
                rerankScore: r.relevance_score,
                rerankProvider: 'voyage',
            }));

        logger.info(
            `[RerankService] ✅ Voyage cross-encoder reranked ${rerankedChunks.length} chunks. ` +
            `Top: ${rerankedChunks[0]?.rerankScore?.toFixed(4)}, ` +
            `Bottom: ${rerankedChunks[rerankedChunks.length - 1]?.rerankScore?.toFixed(4)}`
        );

        return { reranked: true, method: 'voyage-rerank-2', chunks: rerankedChunks };
    }

    // ════════════════════════════════════════════════════════════════
    // PROVIDER 4: Embedding-based Semantic Reranker (FREE)
    // ════════════════════════════════════════════════════════════════
    //
    // This is the KEY upgrade over pure TF-IDF:
    //
    // Uses the EXISTING EmbeddingService (same model used for vector search)
    // to compute TRUE semantic similarity between query and each chunk.
    //
    // How it works:
    //   1. Embed the query → vector Q
    //   2. Embed each chunk → vectors D1, D2, ..., Dn
    //   3. Score = cosine(Q, Di)
    //   4. Sort by score descending
    //
    // This IS semantic reranking (bi-encoder) because:
    //   - Embeddings capture MEANING, not just keywords
    //   - "mitosis en plantas" ≈ "división celular en organismos vegetales"
    //   - The model understands synonyms, paraphrases, and concepts
    //
    // vs Cross-encoder (Cohere/Jina):
    //   - Cross-encoder processes (query, doc) jointly → more accurate
    //   - Bi-encoder embeds separately → faster, cheaper
    //   - For educational quiz generation, bi-encoder is highly effective
    //
    // Cost: $0 (uses existing embedding infrastructure)
    // Latency: ~200-500ms for 10-20 chunks
    //
    // Combined with TF-IDF for hybrid scoring:
    //   final_score = semantic_weight * embedding_cosine + keyword_weight * tfidf_bm25
    // ════════════════════════════════════════════════════════════════

    /**
     * Semantic reranking using embedding cosine similarity + TF-IDF hybrid.
     *
     * This combines:
     *   1. Embedding cosine similarity (60% weight) — TRUE semantic understanding
     *   2. BM25 keyword score (25% weight) — exact term matching
     *   3. N-gram overlap bonus (15% weight) — phrase matching
     *
     * The embedding component is what makes this SEMANTIC rather than keyword-based.
     *
     * @param {string} query
     * @param {Array} chunks
     * @param {number} topK
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array }>}
     */
    async _embeddingSemanticRerank(query, chunks, topK) {
        // Lazy-load EmbeddingService to avoid circular dependencies
        if (!this._embeddingService) {
            try {
                const { EmbeddingService } = await import('./EmbeddingService.js');
                this._embeddingService = EmbeddingService.getInstance();
            } catch (err) {
                logger.warn(`[RerankService] EmbeddingService not available: ${err.message}`);
                throw new Error('EmbeddingService unavailable');
            }
        }

        // ── Step 1: Embed query ──
        let queryEmbedding;
        try {
            queryEmbedding = await this._embeddingService.embedQuery(query);
        } catch (err) {
            logger.warn(`[RerankService] Query embedding failed: ${err.message}`);
            throw new Error(`Query embedding failed: ${err.message}`);
        }

        if (!queryEmbedding || queryEmbedding.length === 0) {
            throw new Error('Query embedding returned empty vector');
        }

        // ── Step 2: Embed all chunks in batch ──
        const chunkTexts = chunks.map(c => c.content || '');
        let chunkEmbeddings;
        try {
            chunkEmbeddings = await this._embeddingService.embedDocuments(chunkTexts);
        } catch (err) {
            logger.warn(`[RerankService] Batch chunk embedding failed: ${err.message}`);
            throw new Error(`Chunk embedding failed: ${err.message}`);
        }

        if (!chunkEmbeddings || chunkEmbeddings.length !== chunks.length) {
            throw new Error(`Embedding count mismatch: got ${chunkEmbeddings?.length}, expected ${chunks.length}`);
        }

        // ── Step 3: Compute semantic + keyword hybrid scores ──
        const queryTokens = tokenize(query);
        const chunkTokenArrays = chunks.map(c => tokenize(c.content || ''));
        const corpus = [queryTokens, ...chunkTokenArrays];
        const idf = computeIDF(corpus);
        const avgDL = chunkTokenArrays.reduce((sum, t) => sum + t.length, 0) / Math.max(chunkTokenArrays.length, 1);

        // Query bigrams for n-gram bonus
        const queryBigrams = [];
        for (let i = 0; i < queryTokens.length - 1; i++) {
            queryBigrams.push(queryTokens[i] + ' ' + queryTokens[i + 1]);
        }

        const scored = chunks.map((chunk, idx) => {
            // ── Semantic score (embedding cosine) ──
            const semanticScore = cosineSimilarityVectors(queryEmbedding, chunkEmbeddings[idx]);

            // ── BM25 keyword score ──
            const bm25 = bm25Score(queryTokens, chunkTokenArrays[idx], idf, avgDL);
            // Normalize BM25 to 0..1 range (approximate)
            const bm25Normalized = Math.min(bm25 / (bm25 + 2), 1);

            // ── N-gram overlap bonus ──
            const contentLower = (chunk.content || '').toLowerCase();
            let ngramBonus = 0;
            for (const bg of queryBigrams) {
                if (contentLower.includes(bg)) ngramBonus += 0.15;
            }
            const queryLower = query.toLowerCase().trim();
            if (queryLower.length > 5 && contentLower.includes(queryLower)) {
                ngramBonus += 0.3;
            }
            ngramBonus = Math.min(ngramBonus, 1); // cap at 1

            // ── Hybrid score ──
            // Semantic dominates (60%) because it understands MEANING
            // BM25 (25%) catches exact keyword matches the embeddings might miss
            // N-gram (15%) rewards exact phrase matches
            const combined = (semanticScore * 0.60) + (bm25Normalized * 0.25) + (ngramBonus * 0.15);

            return {
                ...chunk,
                rerankScore: Math.round(combined * 10000) / 10000,
                rerankProvider: 'embedding-semantic',
                _debug: {
                    semantic: Math.round(semanticScore * 1000) / 1000,
                    bm25: Math.round(bm25Normalized * 1000) / 1000,
                    ngram: Math.round(ngramBonus * 1000) / 1000,
                },
            };
        });

        // Sort by hybrid score descending
        scored.sort((a, b) => b.rerankScore - a.rerankScore);
        const result = scored.slice(0, topK);

        // Log with detailed breakdown for top and bottom
        const top = result[0];
        const bottom = result[result.length - 1];
        logger.info(
            `[RerankService] ✅ Embedding-Semantic reranked ${result.length} chunks. ` +
            `Top: ${top?.rerankScore?.toFixed(4)} (sem=${top?._debug?.semantic}, bm25=${top?._debug?.bm25}, ng=${top?._debug?.ngram}), ` +
            `Bottom: ${bottom?.rerankScore?.toFixed(4)}`
        );

        // Clean debug data for production
        const cleanResult = result.map(({ _debug, ...rest }) => rest);

        return { reranked: true, method: 'embedding-semantic-hybrid', chunks: cleanResult };
    }

    // ════════════════════════════════════════════════════════════════
    // PROVIDER 5: TF-IDF + BM25 Local (Keyword Fallback)
    // ════════════════════════════════════════════════════════════════

    /**
     * Keyword-based reranking using TF-IDF + BM25.
     * This is the final fallback when no semantic providers are available.
     *
     * @param {string} query
     * @param {Array} chunks
     * @param {number} topK
     * @returns {{ reranked: boolean, method: string, chunks: Array }}
     */
    _tfidfBm25Rerank(query, chunks, topK) {
        const queryTokens = tokenize(query);

        if (queryTokens.length === 0) {
            return { reranked: false, method: 'none', chunks };
        }

        const chunkTokenArrays = chunks.map(c => tokenize(c.content || ''));
        const corpus = [queryTokens, ...chunkTokenArrays];
        const idf = computeIDF(corpus);
        const avgDL = chunkTokenArrays.reduce((sum, t) => sum + t.length, 0) / Math.max(chunkTokenArrays.length, 1);

        // TF-IDF del query
        const queryTF = computeTF(queryTokens);
        const queryVec = new Map();
        for (const [term, tf] of queryTF) {
            queryVec.set(term, tf * (idf.get(term) || 0));
        }

        // Bigramas del query
        const queryBigrams = [];
        for (let i = 0; i < queryTokens.length - 1; i++) {
            queryBigrams.push(queryTokens[i] + ' ' + queryTokens[i + 1]);
        }

        const scored = chunks.map((chunk, idx) => {
            const docTokens = chunkTokenArrays[idx];

            // 1. BM25
            const bm25 = bm25Score(queryTokens, docTokens, idf, avgDL);

            // 2. TF-IDF cosine
            const docTF = computeTF(docTokens);
            const docVec = new Map();
            for (const [term, tf] of docTF) {
                docVec.set(term, tf * (idf.get(term) || 0));
            }
            const cosine = this._cosineSimilarityMaps(queryVec, docVec);

            // 3. N-gram overlap bonus
            const contentLower = (chunk.content || '').toLowerCase();
            let ngramBonus = 0;
            for (const bg of queryBigrams) {
                if (contentLower.includes(bg)) ngramBonus += 0.15;
            }
            const queryLower = query.toLowerCase().trim();
            if (queryLower.length > 5 && contentLower.includes(queryLower)) {
                ngramBonus += 0.3;
            }

            // Keyword-only weights
            const combined = (bm25 * 0.45) + (cosine * 0.40) + (ngramBonus * 0.15);

            return {
                ...chunk,
                rerankScore: Math.round(combined * 10000) / 10000,
                rerankProvider: 'tfidf-bm25',
            };
        });

        scored.sort((a, b) => b.rerankScore - a.rerankScore);
        const result = scored.slice(0, topK);

        logger.info(
            `[RerankService] ✅ TF-IDF+BM25 reranked ${result.length} chunks. ` +
            `Top: ${result[0]?.rerankScore?.toFixed(4)}, ` +
            `Bottom: ${result[result.length - 1]?.rerankScore?.toFixed(4)}`
        );

        return { reranked: true, method: 'tfidf-bm25', chunks: result };
    }

    // ════════════════════════════════════════════════════════════════
    // PRIVATE: Utilities
    // ════════════════════════════════════════════════════════════════

    /**
     * Cosine similarity between two TF-IDF sparse vectors (Maps).
     * @param {Map<string, number>} vecA
     * @param {Map<string, number>} vecB
     * @returns {number} 0..1
     */
    _cosineSimilarityMaps(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (const [term, valA] of vecA) {
            normA += valA * valA;
            const valB = vecB.get(term) || 0;
            dotProduct += valA * valB;
        }
        for (const [, valB] of vecB) {
            normB += valB * valB;
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dotProduct / denom : 0;
    }

    /**
     * Enriches query with topic/task context for better reranking precision.
     * @param {string} query
     * @param {string|null} topicName
     * @param {string|null} taskTitle
     * @returns {string}
     */
    _buildEnrichedQuery(query, topicName, taskTitle) {
        const parts = [query];
        if (topicName) parts.push(`tema: ${topicName}`);
        if (taskTitle) parts.push(`tarea: ${taskTitle}`);
        return parts.join(' | ');
    }

    /**
     * Logs reranking performance metrics.
     * @param {string} method
     * @param {number} chunkCount
     * @param {number} startTime
     */
    _logPerformance(method, chunkCount, startTime) {
        const elapsed = Date.now() - startTime;
        const tier = method.includes('cohere') || method.includes('jina') || method.includes('voyage')
            ? '🏆 CROSS-ENCODER'
            : method.includes('embedding')
                ? '🧠 SEMANTIC'
                : '📝 KEYWORD';

        logger.info(
            `[RerankService] ${tier} | Method: ${method} | Chunks: ${chunkCount} | Time: ${elapsed}ms`
        );
    }
}

export default RerankService;
