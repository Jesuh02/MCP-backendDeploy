/**
 * TTSDomainService — Caso de uso para Text-to-Speech.
 *
 * Depende exclusivamente de ITTSPort (puerto de salida).
 * NO importa nada de infraestructura.
 *
 * Principios:
 *   - SRP: solo orquesta lógica de TTS
 *   - DIP: depende de ITTSPort abstracto, no de OpenAI concreto
 *   - OCP: nuevo proveedor TTS = nuevo adaptador, sin tocar este servicio
 */

import { Result } from '../../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../../shared/errors/index.js';

export class TTSDomainService {
    constructor({ ttsPort }) {
        this.tts = ttsPort;
    }

    /**
     * Sintetiza texto a audio en base64.
     * @param {{ text: string, voice?: string, model?: string, format?: string, speed?: number }} params
     * @returns {Promise<Result>}
     */
    async synthesize({ text, voice, model, format, speed }) {
        if (!this.tts.isAvailable()) {
            return Result.fail(new NotFoundError('Servicio TTS no disponible'));
        }

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return Result.fail(new ValidationError('El texto es requerido para síntesis TTS'));
        }

        if (text.length > 4096) {
            return Result.fail(new ValidationError('El texto excede el límite de 4096 caracteres'));
        }
        try {
            const buffer = await this.tts.synthesize(text, { voice, model, format, speed });
            const fmt = format || 'mp3';

            return Result.ok({
                audio: buffer.toString('base64'),
                format: fmt,
                contentType: this._getContentType(fmt),
                size: buffer.length,
                estimatedDuration: this._estimateDuration(text),
            });
        } catch (err) {
            return Result.fail(new ValidationError(`Síntesis TTS falló: ${err.message}`));
        }
    }

    /**
     * Obtiene las voces y formatos disponibles.
     * @returns {Result}
     */
    getCapabilities() {
        return Result.ok({
            available: this.tts.isAvailable(),
            voices: this.tts.getAvailableVoices(),
            formats: this.tts.getSupportedFormats(),
        });
    }

    /** @private */
    _getContentType(format) {
        const types = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
        return types[format] || 'audio/mpeg';
    }

    /** @private */
    _estimateDuration(text) {
        const words = text.split(/\s+/).length;
        return Math.ceil(words / 2.5);
    }
}
export default TTSDomainService;

