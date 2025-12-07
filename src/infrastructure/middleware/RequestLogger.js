/**
 * Request Logger Middleware
 * Logs all incoming HTTP requests
 */

import { logger } from '../logging/Logger.js';

export function requestLogger(req, res, next) {
  const start = Date.now();
  
  // Log request
  logger.info(`→ ${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    query: req.query
  });
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[logLevel](`← ${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
      statusCode: res.statusCode,
      duration,
      contentLength: res.get('content-length')
    });
  });
  
  next();
}

export default requestLogger;
