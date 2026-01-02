/**
 * TTSService.js - Text-to-Speech Service
 * 
 * Provides natural human-like voice synthesis using OpenAI's TTS API.
 * Follows SOLID principles:
 * - Single Responsibility: Only handles TTS conversion
 * - Open/Closed: Extensible for new TTS providers
 * - Liskov Substitution: Can be swapped with other TTS implementations
 * - Interface Segregation: Minimal interface for TTS operations
 * - Dependency Inversion: Depends on abstractions (config), not concrete implementations
 */

import OpenAI from 'openai';

// TTS Provider Interface (for future extensibility)
const TTSProviders = {
    OPENAI: 'openai',
    ELEVENLABS: 'elevenlabs',
    GOOGLE: 'google'
};

// Available voices for OpenAI TTS (human-like, natural voices)
const OpenAIVoices = {
    ALLOY: 'alloy', // Neutral, balanced
    ECHO: 'echo', // Male, warm
    FABLE: 'fable', // British accent
    ONYX: 'onyx', // Deep male voice
    NOVA: 'nova', // Female, friendly (recommended for assistants)
    SHIMMER: 'shimmer' // Female, soft
};

// Audio output formats
const AudioFormats = {
    MP3: 'mp3',
    OPUS: 'opus',
    AAC: 'aac',
    FLAC: 'flac',
    WAV: 'wav',
    PCM: 'pcm'
};

class TTSService {
    constructor() {
        this.provider = TTSProviders.OPENAI;
        this.defaultVoice = OpenAIVoices.NOVA; // Natural female voice
        this.defaultModel = 'tts-1-hd'; // High quality model
        this.defaultFormat = AudioFormats.MP3;
        this.defaultSpeed = 1.0; // Normal speed (0.25 to 4.0)
        this.maxTextLength = 4096; // OpenAI TTS limit

        // Initialize OpenAI client
        this.openai = null;
        this._initializeClient();
    }

    _initializeClient() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new OpenAI({ apiKey });
            console.log('✅ TTSService: OpenAI client initialized');
        } else {
            console.warn('⚠️ TTSService: OPENAI_API_KEY not configured. TTS will not work.');
        }
    }

    /**
     * Check if TTS service is available
     * @returns {boolean}
     */
    isAvailable() {
        return this.openai !== null;
    }

    /**
     * Get available voices
     * @returns {Object}
     */
    getAvailableVoices() {
        return OpenAIVoices;
    }

    /**
     * Synthesize text to speech
     * @param {string} text - Text to convert to speech
     * @param {Object} options - TTS options
     * @param {string} options.voice - Voice to use (default: nova)
     * @param {string} options.model - Model to use (tts-1 or tts-1-hd)
     * @param {string} options.format - Output format (mp3, opus, aac, flac, wav, pcm)
     * @param {number} options.speed - Speed (0.25 to 4.0)
     * @returns {Promise<Buffer>} - Audio buffer
     */
    async synthesize(text, options = {}) {
        if (!this.isAvailable()) {
            throw new Error('TTS service not available. Please configure OPENAI_API_KEY.');
        }

        // Validate and sanitize input
        const sanitizedText = this._sanitizeText(text);
        if (!sanitizedText || sanitizedText.length === 0) {
            throw new Error('Text is required for TTS synthesis.');
        }

        // Merge options with defaults
        const config = {
            voice: options.voice || this.defaultVoice,
            model: options.model || this.defaultModel,
            response_format: options.format || this.defaultFormat,
            speed: Math.min(Math.max(options.speed || this.defaultSpeed, 0.25), 4.0)
        };

        try {
            console.log(`🎤 TTSService: Synthesizing ${sanitizedText.length} chars with voice "${config.voice}"`);
            console.log(`   Model: ${config.model}, Speed: ${config.speed}, Format: ${config.response_format}`);

            const response = await this.openai.audio.speech.create({
                model: config.model,
                voice: config.voice,
                input: sanitizedText,
                response_format: config.response_format,
                speed: config.speed
            });

            // Convert response to buffer
            const buffer = Buffer.from(await response.arrayBuffer());

            console.log(`✅ TTSService: Generated ${buffer.length} bytes of audio`);
            return buffer;
        } catch (error) {
            console.error('❌ TTSService synthesis error:', error.message);
            if (error.response) {
                console.error('   Details:', JSON.stringify(error.response.data || {}));
            }
            throw new Error(`TTS synthesis failed: ${error.message}`);
        }
    }

    /**
     * Synthesize text and return as base64 for easy transport
     * @param {string} text - Text to convert
     * @param {Object} options - TTS options
     * @returns {Promise<Object>} - { audio: base64string, format: string, duration: estimated }
     */
    async synthesizeToBase64(text, options = {}) {
        const buffer = await this.synthesize(text, options);
        const format = options.format || this.defaultFormat;

        return {
            audio: buffer.toString('base64'),
            format: format,
            contentType: this._getContentType(format),
            size: buffer.length,
            estimatedDuration: this._estimateDuration(text)
        };
    }

    /**
     * Sanitize text for TTS processing
     * Removes markdown, excessive whitespace, and special characters
     * @param {string} text - Raw text
     * @returns {string} - Sanitized text
     */
    _sanitizeText(text) {
        if (!text) return '';

        let sanitized = text
            // Remove markdown bold/italic
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            // Remove markdown headers
            .replace(/^#{1,6}\s*/gm, '')
            // Remove markdown links but keep text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Remove markdown code blocks
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`([^`]+)`/g, '$1')
            // Remove bullet points but keep text
            .replace(/^[\s]*[-•*]\s*/gm, '')
            // Remove numbered lists formatting
            .replace(/^[\s]*\d+\.\s*/gm, '')
            // Remove emojis (optional, they may be spoken as descriptions)
            // .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
            // Clean up excessive whitespace
            .replace(/\s+/g, ' ')
            .trim();

        // Truncate if too long
        if (sanitized.length > this.maxTextLength) {
            sanitized = sanitized.substring(0, this.maxTextLength - 3) + '...';
        }

        return sanitized;
    }

    /**
     * Get content type for audio format
     * @param {string} format - Audio format
     * @returns {string} - MIME type
     */
    _getContentType(format) {
        const contentTypes = {
            mp3: 'audio/mpeg',
            opus: 'audio/opus',
            aac: 'audio/aac',
            flac: 'audio/flac',
            wav: 'audio/wav',
            pcm: 'audio/pcm'
        };
        return contentTypes[format] || 'audio/mpeg';
    }

    /**
     * Estimate audio duration based on text length
     * Average speaking rate is ~150 words per minute
     * @param {string} text - Input text
     * @returns {number} - Estimated duration in seconds
     */
    _estimateDuration(text) {
        const words = text.split(/\s+/).length;
        const wordsPerSecond = 2.5; // ~150 words per minute
        return Math.ceil(words / wordsPerSecond);
    }
}

// Singleton instance
let instance = null;

export function getTTSService() {
    if (!instance) {
        instance = new TTSService();
    }
    return instance;
}

export { TTSService, TTSProviders, OpenAIVoices, AudioFormats };
export default TTSService;