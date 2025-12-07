/**
 * Global Error Handler Middleware
 * Catches and formats all errors
 */

import { logger } from '../logging/Logger.js';

export function errorHandler(err, req, res, next) {
  // Log the error
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  // Determine status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Prepare error response
  const errorResponse = {
    error: err.name || 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
    timestamp: new Date().toISOString(),
    path: req.path
  };
  
  // Include stack trace in development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.stack = err.stack;
  }
  
  // Send error response
  res.status(statusCode).json(errorResponse);
}

export default errorHandler;
