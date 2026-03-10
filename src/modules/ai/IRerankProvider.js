/**
 * IRerankProvider Interface
 * Defines the contract for reranking providers (SOLID: Interface Segregation).
 *
 * Reranking re-orders retrieved chunks by TRUE relevance to a query,
 * correcting the approximate ordering from semantic (embedding) search.
 */

export class IRerankProvider {
    /**
     * Rerank a list of chunks by relevance to a query.
     * @param {string} query - The user's search query
     * @param {Array<{ content: string, fileName?: string, chunkIndex?: number }>} chunks - Chunks to rerank
     * @param {{ topK?: number, topicName?: string, taskTitle?: string }} options
     * @returns {Promise<{ reranked: boolean, method: string, chunks: Array<{ content: string, fileName?: string, chunkIndex?: number, rerankScore: number }> }>}
     */
    async rerank(query, chunks, options = {}) {
        throw new Error('Method rerank must be implemented');
    }

    /**
     * Check if the reranking provider is available.
     * @returns {boolean}
     */
    isAvailable() {
        throw new Error('Method isAvailable must be implemented');
    }
}

export default IRerankProvider;
