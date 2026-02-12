/**
 * ttsRoutes.js - TTS API Routes
 * 
 * Provides REST endpoints for Text-to-Speech functionality.
 * Follows SOLID principles with clean separation of concerns.
 */

import express from 'express';
import { getTTSService, OpenAIVoices, AudioFormats } from '../../infrastructure/legacy/TTSService.js';

const router = express.Router();

/**
 * POST /tts/synthesize
 * Convert text to speech and return audio as base64
 * 
 * Request body:
 * {
 *   "text": "Text to convert to speech",
 *   "voice": "nova",      // optional: alloy, echo, fable, onyx, nova, shimmer
 *   "model": "tts-1-hd",  // optional: tts-1 (faster) or tts-1-hd (better quality)
 *   "format": "mp3",      // optional: mp3, opus, aac, flac, wav, pcm
 *   "speed": 1.0          // optional: 0.25 to 4.0
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "audio": "base64encodedaudio...",
 *   "format": "mp3",
 *   "contentType": "audio/mpeg",
 *   "size": 12345,
 *   "estimatedDuration": 5
 * }
 */
router.post('/synthesize', async(req, res) => {
    try {
        const { text, voice, model, format, speed } = req.body;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Text is required for TTS synthesis'
            });
        }

        const ttsService = getTTSService();

        if (!ttsService.isAvailable()) {
            return res.status(503).json({
                success: false,
                error: 'TTS service is not available. Please configure OPENAI_API_KEY.'
            });
        }

        const result = await ttsService.synthesizeToBase64(text, {
            voice,
            model,
            format,
            speed
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('❌ TTS synthesize error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /tts/stream
 * Convert text to speech and stream audio directly
 * Better for larger texts and immediate playback
 */
router.post('/stream', async(req, res) => {
    try {
        const { text, voice, model, format, speed } = req.body;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Text is required for TTS synthesis'
            });
        }

        const ttsService = getTTSService();

        if (!ttsService.isAvailable()) {
            return res.status(503).json({
                success: false,
                error: 'TTS service is not available'
            });
        }

        const audioFormat = format || 'mp3';
        const contentType = ttsService._getContentType(audioFormat);

        // Set streaming headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');

        const stream = await ttsService.stream(text, {
            voice,
            model,
            format: audioFormat,
            speed
        });

        // Pipe the stream to response
        // OpenAI SDK returns a web standard ReadableStream, we need to convert or handle it
        // Node.js response is a WritableStream

        if (stream.pipe) {
            // If it's a Node stream
            stream.pipe(res);
        } else {
            // If it's a Web Stream (fetch API style)
            const reader = stream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
            }
            res.end();
        }

    } catch (error) {
        console.error('❌ TTS stream error:', error.message);
        // If headers sent, we can't send JSON error
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        } else {
            res.end();
        }
    }
});

/**
 * GET /tts/stream
 * Stream audio via GET request (easier for MediaPlayer)
 */
router.get('/stream', async(req, res) => {
    try {
        const { text, voice, model, format, speed } = req.query;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).send('Text is required');
        }

        const ttsService = getTTSService();

        if (!ttsService.isAvailable()) {
            return res.status(503).send('TTS service unavailable');
        }

        const audioFormat = format || 'mp3';
        const contentType = ttsService._getContentType(audioFormat);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Transfer-Encoding', 'chunked');

        const stream = await ttsService.stream(text, {
            voice,
            model,
            format: audioFormat,
            speed: speed ? parseFloat(speed) : undefined
        });

        if (stream.pipe) {
            stream.pipe(res);
        } else {
            const reader = stream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
            }
            res.end();
        }

    } catch (error) {
        console.error('❌ TTS GET stream error:', error.message);
        if (!res.headersSent) {
            res.status(500).send(error.message);
        } else {
            res.end();
        }
    }
});

/**
 * GET /tts/voices
 * Get list of available voices
 */
router.get('/voices', (req, res) => {
    const ttsService = getTTSService();

    res.json({
        success: true,
        voices: Object.entries(OpenAIVoices).map(([key, value]) => ({
            id: value,
            name: key.charAt(0) + key.slice(1).toLowerCase(),
            description: getVoiceDescription(value)
        })),
        available: ttsService.isAvailable()
    });
});

/**
 * GET /tts/formats
 * Get list of supported audio formats
 */
router.get('/formats', (req, res) => {
    res.json({
        success: true,
        formats: Object.values(AudioFormats).map(format => ({
            id: format,
            contentType: getTTSService()._getContentType(format)
        }))
    });
});

/**
 * GET /tts/health
 * Check TTS service health
 */
router.get('/health', (req, res) => {
    const ttsService = getTTSService();

    res.json({
        success: true,
        available: ttsService.isAvailable(),
        provider: 'openai',
        defaultVoice: 'nova',
        defaultModel: 'tts-1-hd'
    });
});

/**
 * Get voice description
 * @param {string} voice - Voice ID
 * @returns {string} - Human-readable description
 */
function getVoiceDescription(voice) {
    const descriptions = {
        alloy: 'Neutral, balanced voice suitable for general use',
        echo: 'Male, warm and friendly voice',
        fable: 'British accent, storytelling voice',
        onyx: 'Deep male voice, authoritative',
        nova: 'Female, friendly and natural (recommended)',
        shimmer: 'Female, soft and gentle voice'
    };
    return descriptions[voice] || 'Natural human voice';
}

export default router;