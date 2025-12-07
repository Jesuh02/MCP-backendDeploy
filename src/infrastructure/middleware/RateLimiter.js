/**
 * Rate Limiting Middleware
 * Protects against DDoS and abuse
 */

import rateLimit from 'express-rate-limit';
import { logger } from '../logging/Logger.js';

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

export const rateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: `You have exceeded the ${MAX_REQUESTS} requests in ${WINDOW_MS / 60000} minutes limit.`,
    retryAfter: WINDOW_MS / 1000
  },
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, Path: ${req.path}`);
    res.status(429).json({
      error: 'Too Many Requests',
      message: `You have exceeded the ${MAX_REQUESTS} requests in ${WINDOW_MS / 60000} minutes limit.`,
      retryAfter: Math.ceil(WINDOW_MS / 1000)
    });
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/health/status';
  }
});

export default rateLimiter;
