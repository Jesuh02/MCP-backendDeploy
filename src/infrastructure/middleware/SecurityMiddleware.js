/**
 * Security Middleware
 * Implements API Key authentication, JWT validation, and request sanitization
 */

import jwt from 'jsonwebtoken';
import { logger } from '../logging/Logger.js';

const API_KEY = process.env.API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  '/health',
  '/health/status',
  '/'
];

/**
 * API Key Authentication Middleware
 */
function apiKeyAuth(req, res, next) {
  // Skip authentication for public routes
  if (PUBLIC_ROUTES.includes(req.path)) {
    return next();
  }
  
  // Skip if no API key is configured (development mode)
  if (!API_KEY) {
    logger.warn('⚠️  API Key authentication is disabled. Set API_KEY in .env for production.');
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    logger.warn(`Missing API key for ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key is required. Provide X-API-Key header.'
    });
  }
  
  if (apiKey !== API_KEY) {
    logger.warn(`Invalid API key attempt from ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }
  
  next();
}

/**
 * JWT Authentication Middleware (optional, for user-specific operations)
 */
function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return next(); // Optional authentication
  }
  
  const token = authHeader.startsWith('Bearer ') 
    ? authHeader.substring(7) 
    : authHeader;
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    logger.debug(`User authenticated: ${decoded.username || decoded.sub}`);
    next();
  } catch (error) {
    logger.warn(`Invalid JWT token: ${error.message}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
}

/**
 * Input Sanitization Middleware
 * Prevents XSS and injection attacks
 */
function sanitizeInput(req, res, next) {
  // Sanitize query parameters
  for (const key in req.query) {
    if (typeof req.query[key] === 'string') {
      req.query[key] = sanitizeString(req.query[key]);
    }
  }
  
  // Sanitize body
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  
  next();
}

function sanitizeString(str) {
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

function sanitizeObject(obj) {
  const sanitized = {};
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      sanitized[key] = sanitizeString(obj[key]);
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitized[key] = sanitizeObject(obj[key]);
    } else {
      sanitized[key] = obj[key];
    }
  }
  return sanitized;
}

/**
 * Combined Security Middleware
 */
export const securityMiddleware = [
  apiKeyAuth,
  jwtAuth,
  sanitizeInput
];

export default securityMiddleware;
