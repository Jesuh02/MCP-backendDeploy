/**
 * ISP — Segregación del IDocumentProcessor en interfaces atómicas.
 *
 * IDocumentProcessor combinaba extracción de texto y splitting en una sola interfaz.
 * Segregamos en:
 *   - ITextExtractor  → extractText(content, fileType)
 *   - ITextSplitter   → splitText(text, options)
 *
 * IDocumentProcessor sigue existiendo como unión backward-compatible.
 * Los servicios que solo necesitan una operación deben depender de la interfaz mínima.
 */

/**
 * ITextExtractor — Extrae texto de archivos binarios/texto.
 */
export class ITextExtractor {
    /**
     * @param {Buffer|string} content — Contenido del archivo.
     * @param {string} fileType — Extensión o tipo (pdf, txt, etc.).
     * @returns {Promise<string>} — Texto extraído.
     */
    async extractText(content, fileType) {
        throw new Error('ITextExtractor.extractText() not implemented');
    }
}

/**
 * ITextSplitter — Divide texto en chunks para embedding/procesamiento.
 */
export class ITextSplitter {
    /**
     * @param {string} text — Texto completo.
     * @param {object} options — { chunkSize, chunkOverlap, minChunkSize }
     * @returns {Promise<string[]>} — Array de chunks.
     */
    async splitText(text, options) {
        throw new Error('ITextSplitter.splitText() not implemented');
    }
}
