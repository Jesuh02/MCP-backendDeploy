/**
 * UnauthorizedError — Credenciales inválidas o ausentes (401).
 */
import { AppError } from './AppError.js';

export class UnauthorizedError extends AppError {
    /**
     * @param {string} [message]
     */
    constructor(message = 'No autorizado — credenciales inválidas o ausentes') {
        super(message, 401, true, 'UNAUTHORIZED');
    }
}

export default UnauthorizedError;