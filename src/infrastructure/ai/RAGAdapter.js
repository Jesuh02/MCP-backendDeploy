/**
 * RAGAdapter — Adaptador de infraestructura que implementa IRAGPort.
 *
 * Envuelve RAGService existente detrás de un puerto abstracto.
 * El dominio (RAGDomainService) solo conoce IRAGPort.
 */

import { RAGService } from '../../domain/services/RAGService.js';

export class RAGAdapter {
    constructor() {
        this._rag = null;
        this._init();
    }

    /** @private */
    _init() {
        try {
            this._rag = new RAGService();
            console.log('✅ RAGAdapter: inicializado');
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