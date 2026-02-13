/**
 * ITTSPort — Puerto de salida para síntesis de voz (Text-to-Speech).
 *
 * Define el contrato que todo adaptador TTS debe cumplir.
 * El dominio depende de esta abstracción, no de OpenAI directamente.
 *
 * @interface
 */
export class ITTSPort {
    /** @returns {boolean} */
    isAvailable() { throw new Error('Not implemented'); }

    /** @returns {Object} Voces disponibles */
    getAvailableVoices() { throw new Error('Not implemented'); }

    /** @returns {Object} Formatos de audio soportados */
    getSupportedFormats() { throw new Error('Not implemented'); }

    /**
     * Sintetiza texto a buffer de audio.
     * @param {string} text
     * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
     * @returns {Promise<Buffer>}
     */
    async synthesize(text, options = {}) { throw new Error('Not implemented'); }

    /**
     * Stream de audio directamente desde el proveedor.
     * @param {string} text
     * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
     * @returns {Promise<ReadableStream>}
     */
    async stream(text, options = {}) { throw new Error('Not implemented'); }

    /**
     * Sintetiza texto y retorna como base64.
     * @param {string} text
     * @param {Object} options
     * @returns {Promise<{ audio: string, format: string, contentType: string, size: number, estimatedDuration: number }>}
     */
    async synthesizeToBase64(text, options = {}) { throw new Error('Not implemented'); }
}
export default ITTSPort;