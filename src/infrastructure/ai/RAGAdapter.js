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
                maxTokens: options.maxTokens,
            });
            return context || '';
        } catch (err) {
            console.warn('[RAGAdapter] buildContext falló:', err.message);
            return '';
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