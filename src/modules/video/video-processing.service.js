/**
 * VideoProcessingDomainService — Caso de uso para procesamiento de video.
 *
 * Depende de IVideoProcessingPort y IFileStoragePort (puertos de salida).
 * NO importa nada de infraestructura (FFmpeg, R2, etc.).
 *
 * Principios:
 *   - SRP: orquesta análisis y procesamiento de video
 *   - DIP: depende de puertos abstractos
 *   - OCP: nuevo encoder = nuevo adaptador
 */

import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';

export class VideoProcessingDomainService {
    constructor({ videoProcessingPort, fileStoragePort }) {
        this.videoProcessor = videoProcessingPort;
        this.storage = fileStoragePort;
    }

    /**
     * Analiza un video para determinar si necesita compresión.
     * @param {{ filePath: string }} params
     * @returns {Promise<Result>}
     */
    async analyze({ filePath }) {
        if (!filePath) {
            return Result.fail(new ValidationError('filePath es requerido'));
        }

        if (!this.videoProcessor.isAvailable()) {
            return Result.fail(new NotFoundError('Servicio de procesamiento de video no disponible (FFmpeg no encontrado)'));
        }
        try {
            const analysis = await this.videoProcessor.analyze(filePath);
            return Result.ok(analysis);
        } catch (err) {
            return Result.fail(new ValidationError(`Análisis de video falló: ${err.message}`));
        }
    }

    /**
     * Procesa un video (compresión / HLS transcoding).
     * @param {{ inputPath: string, qualities?: string[], outputDir?: string }} params
     * @returns {Promise<Result>}
     */
    async process({ inputPath, qualities, outputDir }) {
        if (!inputPath) {
            return Result.fail(new ValidationError('inputPath es requerido'));
        }

        if (!this.videoProcessor.isAvailable()) {
            return Result.fail(new NotFoundError('FFmpeg no disponible'));
        }

        try {
            const result = await this.videoProcessor.process(inputPath, { qualities, outputDir });
            return Result.ok(result);
        } catch (err) {
            return Result.fail(new ValidationError(`Procesamiento de video falló: ${err.message}`));
        }
    }

    /**
     * Procesa un video desde URL.
     * @param {{ url: string, qualities?: string[], outputDir?: string }} params
     * @returns {Promise<Result>}
     */
    async processFromUrl({ url, qualities, outputDir }) {
        if (!url) {
            return Result.fail(new ValidationError('url es requerida'));
        }

        try {
            const result = await this.videoProcessor.processFromUrl(url, { qualities, outputDir });
            return Result.ok(result);
        } catch (err) {
            return Result.fail(new ValidationError(`Procesamiento desde URL falló: ${err.message}`));
        }
    }

    /**
     * Obtiene el estado de un job de procesamiento.
     * @param {string} jobId
     * @returns {Promise<Result>}
     */
    async getJobStatus(jobId) {
        if (!jobId) {
            return Result.fail(new ValidationError('jobId es requerido'));
        }

        try {
            const status = await this.videoProcessor.getJobStatus(jobId);
            return Result.ok(status);
        } catch (err) {
            return Result.fail(new NotFoundError(`Job no encontrado: ${jobId}`));
        }
    }

    /**
     * Obtiene presets de calidad disponibles.
     * @returns {Result}
     */
    getQualityPresets() {
        return Result.ok(this.videoProcessor.getQualityPresets());
    }
}
export default VideoProcessingDomainService;

