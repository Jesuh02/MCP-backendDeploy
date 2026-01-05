/**
 * IEmbeddingProvider Interface
 * Defines the contract for embedding providers (SOLID: Interface Segregation)
 */

export class IEmbeddingProvider {
    /**
     * Generate embedding for a single text
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} - Embedding vector
     */
    async embedQuery(text) {
        throw new Error('Method embedQuery must be implemented');
    }

    /**
     * Generate embeddings for multiple texts
     * @param {string[]} texts - Array of texts to embed
     * @returns {Promise<number[][]>} - Array of embedding vectors
     */
    async embedDocuments(texts) {
        throw new Error('Method embedDocuments must be implemented');
    }
}

export default IEmbeddingProvider;
