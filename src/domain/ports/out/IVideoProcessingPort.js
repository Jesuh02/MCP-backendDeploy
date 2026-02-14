/**
 * IVideoProcessingPort — Puerto de salida para procesamiento de video.
 *
 * Define el contrato que todo adaptador de video debe cumplir.
 * El dominio depende de esta abstracción, no de FFmpeg directamente.
 *
 * @interface
 */
export class IVideoProcessingPort {
    // ── Core ─────────────────────────────────────────────────
    /** @returns {boolean} */
    isAvailable() { throw new Error('Not implemented'); }

    /**
     * Analiza un video y retorna metadata + decisión de compresión.
     * @param {string} filePath
     * @returns {Promise<Object>}
     */
    async analyze(filePath) { throw new Error('Not implemented'); }

    /**
     * Procesa un video: compresión y/o transcodificación.
     * @param {string} inputPath
     * @param {{ qualities?: string[], outputDir?: string }} options
     * @returns {Promise<{ jobId: string, outputPath: string }>}
     */
    async process(inputPath, options = {}) { throw new Error('Not implemented'); }

    /**
     * Descarga y procesa un video desde URL.
     * @param {string} url
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async processFromUrl(url, options = {}) { throw new Error('Not implemented'); }

    /**
     * Obtiene el estado de un job de procesamiento.
     * @param {string} jobId
     * @returns {Promise<Object>}
     */
    async getJobStatus(jobId) { throw new Error('Not implemented'); }

    /** @returns {Object} Presets de calidad disponibles */
    getQualityPresets() { throw new Error('Not implemented'); }

    // ── Extended ─────────────────────────────────────────────

    /**
     * Determina si un video necesita compresión.
     * @param {Object} metadata
     * @param {Object} options
     * @returns {{ shouldCompress: boolean, reason: string, details: Object }}
     */
    shouldCompress(metadata, options = {}) { throw new Error('Not implemented'); }

    /**
     * Determina las calidades objetivo según la resolución fuente.
     * @param {Object} metadata
     * @returns {Object[]}
     */
    getTargetQualities(metadata) { throw new Error('Not implemented'); }

    /**
     * Transcodifica video a HLS con múltiples niveles de calidad.
     * @param {string} inputPath
     * @param {string} outputDir
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async transcodeToHLS(inputPath, outputDir, options = {}) { throw new Error('Not implemented'); }

    /**
     * Comprime video a un formato optimizado.
     * @param {string} inputPath
     * @param {string} outputPath
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async compressVideo(inputPath, outputPath, options = {}) { throw new Error('Not implemented'); }

    /**
     * Aplica optimización fast-start (moov atom al inicio).
     * @param {string} inputPath
     * @param {string} outputPath
     * @returns {Promise<string>}
     */
    async applyFastStart(inputPath, outputPath) { throw new Error('Not implemented'); }

    /**
     * Limpia archivos temporales de un job.
     * @param {string} jobId
     */
    async cleanupJob(jobId) { throw new Error('Not implemented'); }

    /**
     * Genera un thumbnail de un video.
     * @param {string} inputPath
     * @param {string} outputPath
     * @param {number} timestamp — segundos
     * @returns {Promise<string>}
     */
    async generateThumbnail(inputPath, outputPath, timestamp = 1) { throw new Error('Not implemented'); }
}
export default IVideoProcessingPort;

