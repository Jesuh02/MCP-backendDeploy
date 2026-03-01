/**
 * Global Error Handler Middleware
 * Catches and formats all errors — compatible con AppError (Arquitectura Hexagonal)
 */

import { logger } from '../logging/Logger.js';
import { AppError } from '../../shared/errors/AppError.js';

export function errorHandler(err, req, res, _next) {
    const statusCode = err.statusCode || err.status || 500;

    // Log expected 4xx operational errors as warnings to reduce noise.
    // Keep unexpected/server failures as error.
    const logPayload = {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        ip: req.ip
    };

    if ((err instanceof AppError || err.isOperational) && statusCode >= 400 && statusCode < 500) {
        if (!err.silent) logger.warn('Request warning:', logPayload);
    } else {
        logger.error('Error:', logPayload);
    }

    // AppError (errores operacionales controlados)
    if (err instanceof AppError || err.isOperational) {
        return res.status(err.statusCode || 500).json(
            err.toJSON ? err.toJSON() : {
                success: false,
                error: {
                    code: err.code || err.name || 'ERROR',
                    message: err.message,
                    statusCode: err.statusCode || 500,
                    timestamp: new Date().toISOString(),
                    path: req.path,
                },
            }
        );
    }

    // Error de validación Joi
    if (err.isJoi || err.name === 'ValidationError') {
        return res.status(400).json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: err.message,
                statusCode: 400,
                details: err.details || [],
                timestamp: new Date().toISOString(),
                path: req.path,
            },
        });
    }

    // Error inesperado
    const isProduction = process.env.NODE_ENV === 'production';

    const errorResponse = {
        success: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: isProduction ? 'Error interno del servidor' : (err.message || 'An unexpected error occurred'),
            statusCode,
            timestamp: new Date().toISOString(),
            path: req.path,
        },
    };

    if (!isProduction) {
        errorResponse.error.stack = err.stack;
    }

    res.status(statusCode).json(errorResponse);
}

export default errorHandler;

