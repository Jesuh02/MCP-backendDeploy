/**
 * TTSSchemas — Joi schemas para validación de endpoints TTS.
 */

import Joi from 'joi';

export const synthesizeSchema = Joi.object({
    text: Joi.string().min(1).max(4096).required().messages({
        'string.empty': 'El texto es requerido',
        'string.max': 'El texto no puede exceder 4096 caracteres',
    }),
    voice: Joi.string().valid('alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer').optional(),
    model: Joi.string().valid('tts-1', 'tts-1-hd').optional(),
    format: Joi.string().valid('mp3', 'opus', 'aac', 'flac', 'wav', 'pcm').optional(),
    speed: Joi.number().min(0.25).max(4.0).optional(),
});

export default { synthesizeSchema };