/**
 * ITTSPort — Puerto de salida para síntesis de voz (Text-to-Speech).
 * @interface
 */
export class ITTSPort {
    /** @returns {boolean} */
    isAvailable() { throw new Error('Not implemented'); }

    /** @returns {Object} Voces disponibles */
    getAvailableVoices() { throw new Error('Not implemented'); }

    /**
     * Sintetiza texto a audio.
     * @param {string} text
     * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
     * @returns {Promise<Buffer>}
     */
    async synthesize(text, options = {}) { throw new Error('Not implemented'); }
        /**
         * Obtiene los formatos de audio soportados.
         * @returns {Object}
         */
    getSupportedFormats() { throw new Error('Not implemented'); }
}
export default ITTSPort;