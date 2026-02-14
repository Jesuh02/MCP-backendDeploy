/**
 * DocumentProcessor - SOLID: Single Responsibility Principle
 * This service is ONLY responsible for processing documents:
 * - Extracting text from various file formats (PDF, DOCX, TXT)
 * - Splitting text into manageable chunks for embedding
 */

import { IDocumentProcessor } from '../interfaces/IDocumentProcessor.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Lazy load PDF parser to avoid crashes if not installed
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    console.warn("⚠️ pdf-parse not available, PDF processing will be limited");
}

export class DocumentProcessor extends IDocumentProcessor {
    constructor(options = {}) {
        super();
        this.chunkSize = options.chunkSize || 1000;
        this.chunkOverlap = options.chunkOverlap || 200;
        this.minChunkSize = options.minChunkSize || 100;
    }

    /**
     * Extract text from various file formats
     * @param {Buffer|string} content - File content (Buffer for binary, string for text)
     * @param {string} fileType - Type of file (pdf, txt, docx, etc.)
     * @returns {Promise<string>} - Extracted text
     */
    async extractText(content, fileType) {
        const type = (fileType || '').toLowerCase().replace('.', '');

        switch (type) {
            case 'pdf':
                return this._extractFromPDF(content);
            case 'txt':
            case 'sql':
            case 'js':
            case 'ts':
            case 'py':
            case 'java':
            case 'kt':
            case 'json':
            case 'xml':
            case 'html':
            case 'css':
            case 'md':
            case 'csv':
                return this._extractFromText(content);
            default:
                // Try to treat as text
                return this._extractFromText(content);
        }
    }

    /**
     * Extract text from PDF
     * @param {Buffer|string} content - PDF content
     * @returns {Promise<string>} - Extracted text
     */
    async _extractFromPDF(content) {
        if (!pdfParse) {
            throw new Error('PDF parsing not available. Install pdf-parse: npm install pdf-parse');
        }

        try {
            let buffer = content;
            if (typeof content === 'string') {
                // Check if content looks like HTML (error page from R2/server)
                if (content.includes('<!DOCTYPE') || content.includes('<html') || content.includes('<?xml')) {
                    throw new Error('Received HTML/XML instead of PDF binary - likely a server error or missing file');
                }
                
                // Check if it's base64 encoded
                if (content.match(/^[A-Za-z0-9+/=]+$/) && content.length > 100) {
                    buffer = Buffer.from(content, 'base64');
                } else {
                    // Could be raw binary as string
                    buffer = Buffer.from(content, 'binary');
                }
            }

            // Validate that it looks like a PDF (magic bytes: %PDF)
            const pdfMagic = buffer.slice(0, 5).toString('ascii');
            if (!pdfMagic.startsWith('%PDF')) {
                // Check if it's base64 that wasn't detected
                try {
                    const decoded = Buffer.from(buffer.toString('utf8'), 'base64');
                    if (decoded.slice(0, 5).toString('ascii').startsWith('%PDF')) {
                        buffer = decoded;
                    } else {
                        throw new Error(`Invalid PDF: File does not start with %PDF magic bytes (found: ${pdfMagic})`);
                    }
                } catch {
                    throw new Error(`Invalid PDF: File does not start with %PDF magic bytes (found: ${pdfMagic})`);
                }
            }

            const data = await pdfParse(buffer, {
                max: 0 // No page limit
            });

            if (!data.text || data.text.trim().length === 0) {
                throw new Error('PDF appears to be empty or scanned (no extractable text)');
            }

            return this._cleanText(data.text);
        } catch (error) {
            console.error('❌ PDF extraction error:', error.message);
            throw error;
        }
    }

    /**
     * Extract text from plain text content
     * @param {Buffer|string} content - Text content
     * @returns {Promise<string>} - Cleaned text
     */
    async _extractFromText(content) {
        let text = content;
        if (Buffer.isBuffer(content)) {
            text = content.toString('utf-8');
        }
        return this._cleanText(text);
    }

    /**
     * Clean extracted text
     * @param {string} text - Raw text
     * @returns {string} - Cleaned text
     */
    _cleanText(text) {
        if (!text) return '';
        
        return text
            // Normalize whitespace
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // Remove excessive newlines
            .replace(/\n{3,}/g, '\n\n')
            // Remove excessive spaces
            .replace(/[ \t]{2,}/g, ' ')
            // Trim each line
            .split('\n')
            .map(line => line.trim())
            .join('\n')
            .trim();
    }

    /**
     * Split text into chunks using recursive character splitting
     * This method preserves semantic boundaries (paragraphs, sentences)
     * @param {string} text - Text to split
     * @param {object} options - Override options
     * @returns {Promise<string[]>} - Array of text chunks
     */
    async splitText(text, options = {}) {
        if (!text || typeof text !== 'string') {
            return [];
        }

        const chunkSize = options.chunkSize || this.chunkSize;
        const chunkOverlap = options.chunkOverlap || this.chunkOverlap;
        const minChunkSize = options.minChunkSize || this.minChunkSize;

        // If text is smaller than chunk size, return as single chunk
        if (text.length <= chunkSize) {
            return [text.trim()].filter(c => c.length >= minChunkSize);
        }

        const chunks = [];
        const separators = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' '];

        // Recursive splitting function
        const splitRecursively = (text, separatorIndex = 0) => {
            if (text.length <= chunkSize) {
                if (text.trim().length >= minChunkSize) {
                    chunks.push(text.trim());
                }
                return;
            }

            if (separatorIndex >= separators.length) {
                // No more separators, force split
                for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
                    const chunk = text.slice(i, i + chunkSize).trim();
                    if (chunk.length >= minChunkSize) {
                        chunks.push(chunk);
                    }
                }
                return;
            }

            const separator = separators[separatorIndex];
            const parts = text.split(separator);

            let currentChunk = '';
            for (const part of parts) {
                const potentialChunk = currentChunk 
                    ? currentChunk + separator + part 
                    : part;

                if (potentialChunk.length <= chunkSize) {
                    currentChunk = potentialChunk;
                } else {
                    if (currentChunk.trim().length >= minChunkSize) {
                        chunks.push(currentChunk.trim());
                    }
                    
                    if (part.length > chunkSize) {
                        // Part is too big, recurse with next separator
                        splitRecursively(part, separatorIndex + 1);
                        currentChunk = '';
                    } else {
                        // Start new chunk with overlap
                        const words = currentChunk.split(' ');
                        const overlapWords = words.slice(-Math.floor(chunkOverlap / 10));
                        currentChunk = overlapWords.join(' ') + separator + part;
                    }
                }
            }

            // Don't forget the last chunk
            if (currentChunk.trim().length >= minChunkSize) {
                chunks.push(currentChunk.trim());
            }
        };

        splitRecursively(text);

        // Remove duplicates while preserving order
        const seen = new Set();
        const uniqueChunks = chunks.filter(chunk => {
            const normalized = chunk.toLowerCase().substring(0, 100);
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });

        console.log(`📄 Split document into ${uniqueChunks.length} chunks (avg ${Math.round(text.length / uniqueChunks.length)} chars/chunk)`);
        return uniqueChunks;
    }

    /**
     * Process a file: extract text and split into chunks
     * @param {Buffer|string} content - File content
     * @param {string} fileType - File type
     * @param {object} options - Processing options
     * @returns {Promise<{text: string, chunks: string[]}>} - Processed result
     */
    async processFile(content, fileType, options = {}) {
        const text = await this.extractText(content, fileType);
        const chunks = await this.splitText(text, options);
        
        return {
            text,
            chunks,
            metadata: {
                originalLength: text.length,
                chunkCount: chunks.length,
                avgChunkSize: Math.round(text.length / (chunks.length || 1)),
                fileType
            }
        };
    }
}

export default DocumentProcessor;



