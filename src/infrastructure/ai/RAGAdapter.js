/**
 * RAGAdapter — Adaptador de infraestructura que implementa IRAGPort.
 *
 * Envuelve RAGService existente detrás de un puerto abstracto.
 * El dominio (RAGDomainService) solo conoce IRAGPort.
 *
 * RAGService is loaded lazily to prevent blocking server startup.
 * The RAG subsystem is non-critical for the core video/user API.
 */

export class RAGAdapter {
    constructor() {
        this._rag = null;
        this._initPromise = null;
    }

    /**
     * Lazy initialization: RAGService is only loaded when first needed.
     * This prevents heavy Supabase/VectorStore/Embedding initialization
     * from blocking Express startup and causing Railway 502 errors.
     */
    async _ensureInitialized() {
        if (this._rag) return;
        if (this._initPromise) {
            await this._initPromise;
            return;
        }
        this._initPromise = this._doInit();
        await this._initPromise;
    }

    /** @private */
    async _doInit() {
        try {
            const { RAGService } = await
            import ('../../domain/services/RAGService.js');
            this._rag = new RAGService();
            console.log('✅ RAGAdapter: inicializado (lazy)');
        } catch (err) {
            console.warn('⚠️ RAGAdapter: RAGService no disponible:', err.message);
        }
    }

    /**
     * Ingesta un documento.
     * @param {{ content: string, metadata?: Object, courseId?: number }} doc
     * @returns {Promise<{ documentId: string, chunksProcessed: number }>}
     */
    async ingest({ content, metadata, courseId }) {
        await this._ensureInitialized();
        if (!this._rag || !this._rag.isReady()) {
            throw new Error('RAG service no disponible');
        }

        const result = await this._rag.ingestDocument(content, {
            ...metadata,
            courseId,
        });

        return {
            documentId: result.documentId || `doc_${Date.now()}`,
            chunksProcessed: result.chunksStored || 0,
        };
    }

    /**
     * Busca documentos relevantes.
     * @param {string} query
     * @param {{ limit?: number, courseId?: number, threshold?: number }} options
     * @returns {Promise<Array<{ content: string, score: number, metadata: Object }>>}
     */
    async search(query, options = {}) {
        await this._ensureInitialized();
        if (!this._rag || !this._rag.isReady()) {
            throw new Error('RAG service no disponible');
        }

        const results = await this._rag.searchKnowledge(query, {
            topK: options.limit,
            courseId: options.courseId,
            threshold: options.threshold,
        });

        return (results || []).map(r => ({
            content: r.content || r.text || '',
            score: r.score || r.similarity || 0,
            metadata: r.metadata || {},
        }));
    }

    /**
     * Construye contexto para el LLM.
     * @param {string} query
     * @param {{ courseId?: number, maxTokens?: number }} options
     * @returns {Promise<string>}
     */
    async buildContext(query, options = {}) {
        await this._ensureInitialized();
        if (!this._rag || !this._rag.isReady()) {
            return '';
        }

        try {
            const context = await this._rag.buildContext(query, {
                courseId: options.courseId,
                topicId: options.topicId || null,
                taskId: options.taskId || null,
                maxTokens: options.maxTokens,
            });
            return context || '';
        } catch (err) {
            console.warn('[RAGAdapter] buildContext falló:', err.message);
            return '';
        }
    }

    /**
     * Hybrid Retrieval: Semantic Search + Window Expansion + Progressive Coverage.
     * @param {string} query - Search query for semantic component
     * @param {{ courseId?: number, topicId?: number, taskId?: number }} filter
     * @param {{ semanticTopK?: number, windowSize?: number, sessionIndex?: number, maxTokens?: number }} options
     * @returns {Promise<{ content: string, chunks: number, files: string[], semanticHits: number, expandedChunks: number, page?: number, totalPages?: number, totalChunks?: number }>}
     */
    async getHybridRagContent(query, filter = {}, options = {}) {
        await this._ensureInitialized();
        if (!this._rag || !this._rag.isReady()) {
            return { content: '', chunks: 0, files: [], semanticHits: 0, expandedChunks: 0 };
        }

        try {
            if (typeof this._rag.getHybridRagContent === 'function') {
                return await this._rag.getHybridRagContent(query, filter, options);
            }
            // Fallback if RAGService doesn't have hybrid method yet
            console.warn('[RAGAdapter] getHybridRagContent not available on RAGService, using buildContext');
            const context = await this._rag.buildContext(query, { ...filter, maxTokens: options.maxTokens });
            return { content: context, chunks: 0, files: [], semanticHits: 0, expandedChunks: 0 };
        } catch (err) {
            console.warn('[RAGAdapter] getHybridRagContent falló:', err.message);
            return { content: '', chunks: 0, files: [], semanticHits: 0, expandedChunks: 0 };
        }
    }

    /**
     * Progressive RAG content retrieval.
     * @param {{ courseId?: number, topicId?: number, taskId?: number }} filter
     * @param {number} sessionIndex
     * @returns {Promise<{ content: string, chunks: number, files: string[], page: number, totalPages: number, totalChunks: number }>}
     */
    async getProgressiveRagContent(filter = {}, sessionIndex = 0) {
        await this._ensureInitialized();
        if (!this._rag || !this._rag.isReady()) {
            return { content: '', chunks: 0, files: [], page: 0, totalPages: 0, totalChunks: 0 };
        }

        try {
            if (typeof this._rag.getProgressiveRagContent === 'function') {
                return await this._rag.getProgressiveRagContent(filter, sessionIndex);
            }
            const fallback = await this._rag.getRagContent(filter);
            return { ...fallback, page: 0, totalPages: 1, totalChunks: fallback.chunks };
        } catch (err) {
            console.warn('[RAGAdapter] getProgressiveRagContent falló:', err.message);
            return { content: '', chunks: 0, files: [], page: 0, totalPages: 0, totalChunks: 0 };
        }
    }

    /**
     * Obtiene estado del servicio.
     * @returns {Promise<{ available: boolean, documentsCount: number }>}
     */
    async getStatus() {
        return {
            available: this._rag ? this._rag.isReady() : false,
            documentsCount: 0, // Could query count from vector store
        };
    }
}
export default RAGAdapter;

