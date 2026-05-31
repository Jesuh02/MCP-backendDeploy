/**
 * Rate Limiters Granulares — Por usuario y endpoint.
 *
 * Complementa el rate limiter global con límites específicos para
 * endpoints costosos (AI, TTS, video processing).
 *
 * Cada limiter usa `req.user.userId` como key para limitar por usuario autenticado.
 * Si no hay usuario autenticado, cae al IP como fallback.
 */
import rateLimit from 'express-rate-limit';
import { logger } from '../logging/Logger.js';

/**
 * Key generator que usa userId si está autenticado, IP si no.
 * @param {string} namespace — Prefijo para separar buckets por endpoint.
 */
function userKeyGenerator(namespace) {
    return (req) => {
        const userId = req.user?.userId;
        return userId ? `${namespace}:user:${userId}` : `${namespace}:ip:${req.ip}`;
    };
}

function createHandler(limitName, windowMs, max) {
    return (req, res) => {
        const key = (req.user && req.user.userId) ? `user:${req.user.userId}` : `ip:${req.ip}`;
        logger.warn(`[RateLimit:${limitName}] exceeded for ${key}, Path: ${req.path}`);
        res.status(429).json({
            error: 'Too Many Requests',
            message: `Has excedido el límite de ${max} peticiones en ${windowMs / 1000}s para ${limitName}.`,
            retryAfter: Math.ceil(windowMs / 1000),
        });
    };
}

/**
 * AI endpoints — 10 req/min por usuario
 * Protege: /llm/chat, /rag, /reinforcement
 */
export const aiRateLimiter = rateLimit({
    windowMs: 60000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKeyGenerator('ai'),
    handler: createHandler('AI', 60000, 10),
});

/**
 * TTS endpoints — 5 req/min por usuario
 * Protege: /tts/synthesize
 */
export const ttsRateLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKeyGenerator('tts'),
    handler: createHandler('TTS', 60000, 5),
});

/**
 * Video processing — 3 req/min por usuario
 * Protege: /video-processing/analyze, /video-processing/process
 */
export const videoProcessingRateLimiter = rateLimit({
    windowMs: 60000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKeyGenerator('video-proc'),
    handler: createHandler('VideoProcessing', 60000, 3),
});

/**
 * Auth endpoints — 10 req/min por IP (brute force protection)
 * Protege: /auth/login, /auth/register
 */
export const authRateLimiter = rateLimit({
    windowMs: 60000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `auth:ip:${req.ip}`,
    handler: createHandler('Auth', 60000, 10),
});

/**
 * Payment endpoints — 5 req/min por usuario
 */
export const paymentRateLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKeyGenerator('payment'),
    handler: createHandler('Payment', 60000, 5),
});

/**
 * Sign-language inference — 60 req/min por usuario
 * Usado en bucle de cámara en tiempo real; necesita límite más alto
 * que los endpoints LLM/AI que son costosos por petición.
 */
export const signLanguageRateLimiter = rateLimit({
    windowMs: 60000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKeyGenerator('sign-lang'),
    handler: createHandler('SignLanguage', 60000, 60),
});

export default {
    aiRateLimiter,
    ttsRateLimiter,
    videoProcessingRateLimiter,
    authRateLimiter,
    paymentRateLimiter,
    signLanguageRateLimiter,
};