/**
 * DocumentProcessor - SOLID: Single Responsibility Principle
 * This service is ONLY responsible for processing documents:
 * - Extracting text from various file formats (PDF, DOCX, TXT)
 * - Splitting text into manageable chunks for embedding
 */

import { IDocumentProcessor } from './IDocumentProcessor.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Lazy load PDF parser to avoid crashes if not installed
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    console.warn("⚠️ pdf-parse not available, PDF processing will be limited");
}

// Lazy load mammoth for DOCX extraction
let mammoth = null;
try {
    mammoth = require('mammoth');
} catch (e) {
    console.warn("⚠️ mammoth not available, DOCX processing will be skipped");
}

// Lazy load JSZip for PPTX extraction
let JSZip = null;
try {
    JSZip = require('jszip');
} catch (e) {
    console.warn("⚠️ jszip not available, PPTX processing will be skipped");
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

        // Auto-detect DOCX/ZIP binary content mislabeled as 'txt' or unknown
        if ((type === 'txt' || type === '' || type === 'unknown') && content) {
            const detected = this._detectBinaryFormat(content);
            if (detected === 'docx') {
                console.log('[DocumentProcessor] Auto-detected DOCX content mislabeled as txt — routing to DOCX extractor');
                return this._extractFromDocx(content);
            }
            if (detected === 'pdf') {
                console.log('[DocumentProcessor] Auto-detected PDF content mislabeled as txt — routing to PDF extractor');
                return this._extractFromPDF(content);
            }
            if (detected === 'office_xml_garbage') {
                console.warn('[DocumentProcessor] Detected Office XML garbage content — rejecting');
                throw new Error('Content is Office XML garbage (unpacked DOCX). Use mammoth to extract text from the original .docx file.');
            }
        }

        switch (type) {
            case 'pdf':
                return this._extractFromPDF(content);
            case 'docx':
            case 'doc':
                return this._extractFromDocx(content);
            case 'pptx':
            case 'ppt':
                return this._extractFromPptx(content);
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
     * Extract plain text from a DOCX file using mammoth.
     * Handles both Buffer input and base64-encoded strings.
     * @param {Buffer|string} content - DOCX binary content or base64 string
     * @returns {Promise<string>} - Extracted plain text
     */
    async _extractFromDocx(content) {
        if (!mammoth) {
            throw new Error('DOCX parsing not available. Install mammoth: npm install mammoth');
        }
        try {
            let buffer = content;
            if (typeof content === 'string') {
                // Accept both base64-encoded and raw binary strings
                buffer = Buffer.from(content, 'base64');
                // Verify it starts with the ZIP magic bytes (PK = 0x50 0x4B) used by OOXML/docx
                if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
                    // Maybe it was passed as a raw binary string — retry with 'binary'
                    buffer = Buffer.from(content, 'binary');
                }
            }

            const result = await mammoth.extractRawText({ buffer });
            if (result.messages && result.messages.length > 0) {
                result.messages.forEach(m => m.type === 'error' && console.warn('mammoth warning:', m.message));
            }
            if (!result.value || result.value.trim().length === 0) {
                throw new Error('DOCX appears to be empty or could not be parsed');
            }
            return this._cleanText(result.value);
        } catch (error) {
            console.error('❌ DOCX extraction error:', error.message);
            throw error;
        }
    }

    /**
     * Extract text from a PPTX file by reading slide XML entries.
     * PPTX files are ZIP archives; text lives in <a:t> tags inside ppt/slides/slideN.xml.
     * @param {Buffer|string} content - PPTX binary content or base64 string
     * @returns {Promise<string>} - Extracted plain text
     */
    async _extractFromPptx(content) {
        if (!JSZip) {
            throw new Error('PPTX parsing not available. Install jszip: npm install jszip');
        }
        try {
            let buffer = content;
            if (typeof content === 'string') {
                buffer = Buffer.from(content, 'base64');
                if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
                    buffer = Buffer.from(content, 'binary');
                }
            }

            const zip = await JSZip.loadAsync(buffer);

            // Collect slide entries sorted numerically
            const slideEntries = Object.keys(zip.files)
                .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
                .sort((a, b) => {
                    const numA = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
                    const numB = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
                    return numA - numB;
                });

            if (slideEntries.length === 0) {
                throw new Error('PPTX contains no slide entries');
            }

            const slideTexts = [];
            for (const entry of slideEntries) {
                const xml = await zip.files[entry].async('text');
                // Extract all <a:t>…</a:t> text nodes
                const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
                const texts = matches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
                if (texts.length > 0) {
                    slideTexts.push(texts.join(' '));
                }
            }

            const fullText = slideTexts.join('\n\n');
            if (!fullText || fullText.trim().length === 0) {
                throw new Error('PPTX appears to be empty or contains no extractable text');
            }
            return this._cleanText(fullText);
        } catch (error) {
            console.error('❌ PPTX extraction error:', error.message);
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
     * Detect if content is binary (DOCX/PDF) mislabeled as text.
     * Checks magic bytes, Office XML patterns, and control character density.
     * @param {Buffer|string} content
     * @returns {string|null} - 'docx', 'pdf', 'office_xml_garbage', or null
     * @private
     */
    _detectBinaryFormat(content) {
        if (!content) return null;

        // Check Buffer magic bytes
        if (Buffer.isBuffer(content)) {
            if (content.length >= 4) {
                // ZIP magic (PK\x03\x04) — DOCX/XLSX/PPTX
                if (content[0] === 0x50 && content[1] === 0x4B && content[2] === 0x03 && content[3] === 0x04) {
                    return 'docx';
                }
                // PDF magic (%PDF)
                if (content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46) {
                    return 'pdf';
                }
            }
            return null;
        }

        // Check string content
        if (typeof content === 'string' && content.length >= 10) {
            const sample = content.substring(0, 2000);

            // ZIP magic as string
            if (sample.startsWith('PK\x03\x04') || sample.startsWith('PK')) return 'docx';
            // PDF magic as string
            if (sample.startsWith('%PDF')) return 'pdf';

            // Office XML namespace patterns (unpacked DOCX treated as text)
            const officeXmlSignals = [
                'schemas.openxmlformats.org',
                'schemas.microsoft.com/office',
                '<w:document', '<w:body', '<w:r>', '<w:p>', '<w:t>',
                'word/document.xml', '[Content_Types].xml', 'docProps/core.xml',
            ];
            const hits = officeXmlSignals.filter(s => sample.includes(s)).length;
            if (hits >= 2) return 'office_xml_garbage';
        }

        return null;
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



