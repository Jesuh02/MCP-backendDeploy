/**
 * IVideoProcessingPort — Puerto de salida para procesamiento de video (FFmpeg).
 * @interface
 */
export class IVideoProcessingPort {
    /**
     * Analiza un video y retorna metadata + decisión de compresión.
     * @param {string} filePath - Ruta al archivo de video
     * @returns {Promise<{ duration: number, width: number, height: number, fps: number, bitrate: number, needsCompression: boolean }>}
     */
    async analyze(filePath) { throw new Error('Not implemented'); }

    /**
     * Procesa un video: compresión y/o HLS transcoding.
     * @param {string} inputPath
     * @param {{ qualities?: string[], outputDir?: string }} options
     * @returns {Promise<{ outputPath: string, hlsManifest?: string, segments?: string[] }>}
     */
    async process(inputPath, options = {}) { throw new Error('Not implemented'); }

    /**
     * Descarga un video desde URL y lo procesa.
     * @param {string} url
     * @param {{ qualities?: string[], outputDir?: string }} options
     * @returns {Promise<{ outputPath: string, hlsManifest?: string }>}
     */
    async processFromUrl(url, options = {}) { throw new Error('Not implemented'); }

    /**
     * Obtiene el estado de un job de procesamiento.
     * @param {string} jobId
     * @returns {Promise<{ status: string, progress: number, result?: Object }>}
     */
    async getJobStatus(jobId) { throw new Error('Not implemented'); }

    /**
     * @returns {Object} Presets de calidad disponibles
     */
    getQualityPresets() { throw new Error('Not implemented'); }
        /** @returns {boolean} */
    isAvailable() { throw new Error('Not implemented'); }
}
export default IVideoProcessingPort;