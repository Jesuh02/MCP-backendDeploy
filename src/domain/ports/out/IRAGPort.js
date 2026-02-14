/**
 * IRAGPort — Puerto de salida para Retrieval-Augmented Generation (Vector Store).
 * @interface
 */
export class IRAGPort {
    /**
     * Ingesta un documento en el vector store.
     * @param {{ content: string, metadata?: Object, courseId?: number }} doc
     * @returns {Promise<{ documentId: string, chunksProcessed: number }>}
     */
    async ingest(doc) { throw new Error('Not implemented'); }
        /**
         * Busca documentos relevantes por query.
         * @param {string} query
         * @param {{ limit?: number, courseId?: number, threshold?: number }} options
         * @returns {Promise<Array<{ content: string, score: number, metadata: Object }>>}
         */
    async search(query, options = {}) { throw new Error('Not implemented'); }

    /**
     * Construye contexto para el LLM basado en la query.
     * @param {string} query
     * @param {{ courseId?: number, maxTokens?: number }} options
     * @returns {Promise<string>}
     */
    async buildContext(query, options = {}) { throw new Error('Not implemented'); }
        /**
         * Obtiene el estado del servicio RAG.
         * @returns {Promise<{ available: boolean, documentsCount: number }>}
         */
    async getStatus() { throw new Error('Not implemented'); }
}
export default IRAGPort;

