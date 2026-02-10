/**
 * ForbiddenError — El usuario autenticado no tiene permisos (403).
 */
import { AppError } from './AppError.js';

export class ForbiddenError extends AppError {
    /**
     * @param {string} [message]
     */
    constructor(message = 'Acceso denegado — permisos insuficientes') {
        super(message, 403, true, 'FORBIDDEN');
    }
}

export default ForbiddenError;