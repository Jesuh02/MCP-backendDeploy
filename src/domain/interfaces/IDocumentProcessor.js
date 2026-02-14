/**
 * IDocumentProcessor Interface
 * Defines the contract for document processing (SOLID: Interface Segregation)
 */

export class IDocumentProcessor {
    /**
     * Split text into chunks
     * @param {string} text - Text to split
     * @param {object} options - Splitting options
     * @returns {Promise<string[]>} - Array of text chunks
     */
    async splitText(text, options) {
        throw new Error('Method splitText must be implemented');
    }

    /**
     * Extract text from a file
     * @param {Buffer|string} content - File content
     * @param {string} fileType - Type of file (pdf, txt, etc.)
     * @returns {Promise<string>} - Extracted text
     */
    async extractText(content, fileType) {
        throw new Error('Method extractText must be implemented');
    }
}

export default IDocumentProcessor;


