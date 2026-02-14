/**
 * AppError — Clase base para todos los errores de aplicación.
 * 
 * Distingue entre errores operacionales (esperados — 4xx) y errores de
 * programación (inesperados — 5xx).
 * 
 * @extends Error
 */
export class AppError extends Error {
    /**
     * @param {string} message  — Mensaje legible para el consumidor de la API.
     * @param {number} statusCode — Código HTTP (default 500).
     * @param {boolean} isOperational — true = error controlado, false = bug.
     * @param {string} [code] — Código interno de error (ej: 'USER_NOT_FOUND').
     */
    constructor(message, statusCode = 500, isOperational = true, code = null) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.code = code;
        this.timestamp = new Date().toISOString();

        // Captura la traza sin incluir el constructor propio
        Error.captureStackTrace(this, this.constructor);
    }

    /**
     * Serializa el error para la respuesta HTTP.
     * @returns {object}
     */
    toJSON() {
        return {
            success: false,
            error: {
                code: this.code || this.name,
                message: this.message,
                statusCode: this.statusCode,
                timestamp: this.timestamp,
            },
        };
    }
}

export default AppError;

