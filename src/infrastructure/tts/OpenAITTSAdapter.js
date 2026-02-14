/**
 * OpenAITTSAdapter — Adaptador de infraestructura que implementa ITTSPort.
 *
 * Envuelve la lógica de OpenAI TTS.
 * El dominio solo conoce ITTSPort; este adaptador es intercambiable.
 *
 * Principios:
 *   - SRP: solo síntesis de voz vía OpenAI
 *   - DIP: el dominio depende de ITTSPort, no de este adaptador
 *   - OCP: intercambiable por ElevenLabsAdapter, GoogleTTSAdapter, etc.
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

const CONTENT_TYPES = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
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
            console.log('✅ OpenAITTSAdapter: initialized');
        }
    }

    // ── ITTSPort ─────────────────────────────────────────────

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
     * Synthesize text to audio buffer.
     * @param {string} text
     * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
     * @returns {Promise<Buffer>}
     */
    async synthesize(text, options = {}) {
        this._ensureAvailable();
        const config = this._buildConfig(text, options);

        const response = await this.openai.audio.speech.create(config);
        return Buffer.from(await response.arrayBuffer());
    }

    /**
     * Stream audio directly from OpenAI.
     * @param {string} text
     * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
     * @returns {Promise<ReadableStream>}
     */
    async stream(text, options = {}) {
        this._ensureAvailable();
        const config = this._buildConfig(text, options);

        const response = await this.openai.audio.speech.create(config);
        return response.body;
    }

    /**
     * Synthesize text and return as base64 for easy transport.
     * @param {string} text
     * @param {{ voice?: string, model?: string, format?: string, speed?: number }} options
     * @returns {Promise<{ audio: string, format: string, contentType: string, size: number, estimatedDuration: number }>}
     */
    async synthesizeToBase64(text, options = {}) {
        const buffer = await this.synthesize(text, options);
        const format = options.format || this.defaultFormat;

        return {
            audio: buffer.toString('base64'),
            format,
            contentType: CONTENT_TYPES[format] || 'audio/mpeg',
            size: buffer.length,
            estimatedDuration: this._estimateDuration(text),
        };
    }

    // ── Private Helpers ──────────────────────────────────────

    /** @private */
    _ensureAvailable() {
        if (!this.isAvailable()) {
            throw new Error('OpenAI TTS not available. Configure OPENAI_API_KEY.');
        }
    }

    /** @private */
    _buildConfig(text, options) {
        const sanitized = this._sanitize(text);
        if (!sanitized || sanitized.length === 0) {
            throw new Error('Text is required for TTS synthesis.');
        }

        return {
            model: options.model || this.defaultModel,
            voice: options.voice || this.defaultVoice,
            input: sanitized,
            response_format: options.format || this.defaultFormat,
            speed: Math.min(Math.max(options.speed || this.defaultSpeed, 0.25), 4.0),
        };
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

    /** @private */
    _estimateDuration(text) {
        const words = (text || '').split(/\s+/).length;
        return Math.ceil(words / 2.5); // ~150 words/min
    }
}

export default OpenAITTSAdapter;

