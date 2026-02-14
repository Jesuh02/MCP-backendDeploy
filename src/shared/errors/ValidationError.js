/**
 * ValidationError — Error de validación de datos de entrada (400).
 */
import { AppError } from './AppError.js';

export class ValidationError extends AppError {
    /**
     * @param {string} message — Descripción del error de validación.
     * @param {Array<object>} [details] — Detalles granulares (uno por campo).
     */
    constructor(message = 'Datos de entrada inválidos', details = []) {
        super(message, 400, true, 'VALIDATION_ERROR');
        /** @type {Array<{field: string, message: string}>} */
        this.details = details;
    }

    /**
     * Fábrica desde un resultado de Joi.
     * @param {import('joi').ValidationError} joiError
     * @returns {ValidationError}
     */
    static fromJoi(joiError) {
        const details = joiError.details.map((d) => ({
            field: d.path.join('.'),
            message: d.message,
        }));
        return new ValidationError(joiError.message, details);
    }

    toJSON() {
        const base = super.toJSON();
        base.error.details = this.details;
        return base;
    }
}

export default ValidationError;

