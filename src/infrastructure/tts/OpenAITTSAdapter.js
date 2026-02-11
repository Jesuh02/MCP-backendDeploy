/**
 * OpenAITTSAdapter — Adaptador de infraestructura que implementa ITTSPort.
 *
 * Envuelve la lógica de OpenAI TTS que antes vivía en services/TTSService.js.
 * El dominio solo conoce ITTSPort; este adaptador es intercambiable.
 */

import OpenAI from 'openai';

const VOICES = {
    ALLOY: 'alloy',
    ECHO: 'echo',
    FABLE: 'fable',
    ONYX: 'onyx',
    NOVA: 'nova',
    SHIMMER: 'shimmer',
};

const FORMATS = {
    MP3: 'mp3',
    OPUS: 'opus',
    AAC: 'aac',
    FLAC: 'flac',
    WAV: 'wav',
    PCM: 'pcm',
};
export class OpenAITTSAdapter {
    constructor() {
        this.openai = null;
        this.defaultVoice = VOICES.NOVA;
        this.defaultModel = 'tts-1-hd';
        this.defaultFormat = FORMATS.MP3;
        this.defaultSpeed = 1.0;
        this.maxTextLength = 4096;
        this._init();
    }

    /** @private */
    _init() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new OpenAI({ apiKey });
            console.log('✅ OpenAITTSAdapter: inicializado');
        }
    }

    /** @returns {boolean} */
    isAvailable() {
        return this.openai !== null;
    }

    /** @returns {Object} */
    getAvailableVoices() {
            return VOICES;
        }
        /** @returns {Object} */
    getSupportedFormats() {
            return FORMATS;
        }
        /**
         * @param {string} text
         * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
         * @returns {Promise<Buffer>}
         */
    async synthesize(text, options = {}) {
        if (!this.isAvailable()) {
            throw new Error('OpenAI TTS no disponible. Configure OPENAI_API_KEY.');
        }

        const sanitized = this._sanitize(text);
        if (!sanitized || sanitized.length === 0) {
            throw new Error('Texto requerido para síntesis TTS.');
        }

        const config = {
            model: options.model || this.defaultModel,
            voice: options.voice || this.defaultVoice,
            input: sanitized,
            response_format: options.format || this.defaultFormat,
            speed: Math.min(Math.max(options.speed || this.defaultSpeed, 0.25), 4.0),
        };

        const response = await this.openai.audio.speech.create(config);
        return Buffer.from(await response.arrayBuffer());
    }

    /** @private */
    _sanitize(text) {
        if (!text) return '';
        return text
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            .replace(/#{1,6}\s?/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^[\s]*[-•*]\s*/gm, '')
            .replace(/^[\s]*\d+\.\s*/gm, '')
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
            .replace(/[\u{2600}-\u{26FF}]/gu, '')
            .replace(/[\u{2700}-\u{27BF}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, this.maxTextLength);
    }
}
export default OpenAITTSAdapter;