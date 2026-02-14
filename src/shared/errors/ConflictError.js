/**
 * ConflictError — Conflicto con el estado actual del recurso (409).
 * Ej: registro duplicado, violación de unicidad.
 */
import { AppError } from './AppError.js';

export class ConflictError extends AppError {
    /**
     * @param {string} [message]
     */
    constructor(message = 'Conflicto — el recurso ya existe') {
        super(message, 409, true, 'CONFLICT');
    }
}

export default ConflictError;

