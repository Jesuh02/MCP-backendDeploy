/**
 * IVectorStore Interface
 * Defines the contract for vector storage providers (SOLID: Interface Segregation)
 */

export class IVectorStore {
    /**
     * Store a document chunk with its embedding
     * @param {string} content - The text content
     * @param {number[]} embedding - The embedding vector
     * @param {object} metadata - Additional metadata
     * @returns {Promise<object>} - Stored document
     */
    async store(content, embedding, metadata) {
        throw new Error('Method store must be implemented');
    }

    /**
     * Search for similar documents
     * @param {number[]} queryEmbedding - The query embedding vector
     * @param {number} topK - Number of results to return
     * @param {number} threshold - Similarity threshold
     * @param {object} filter - Metadata filter
     * @returns {Promise<object[]>} - Similar documents
     */
    async search(queryEmbedding, topK, threshold, filter) {
        throw new Error('Method search must be implemented');
    }

    /**
     * Delete documents by filter
     * @param {object} filter - Metadata filter
     * @returns {Promise<number>} - Number of deleted documents
     */
    async delete(filter) {
        throw new Error('Method delete must be implemented');
    }
}

export default IVectorStore;
