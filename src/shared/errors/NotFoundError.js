/**
 * NotFoundError — Recurso no encontrado (404).
 */
import { AppError } from './AppError.js';

export class NotFoundError extends AppError {
    /**
     * @param {string} [resource] — Nombre del recurso (ej: 'Usuario').
     * @param {string|number} [id] — Identificador buscado.
     */
    constructor(resource = 'Recurso', id = null) {
        const message = id ?
            `${resource} con id '${id}' no encontrado` :
            `${resource} no encontrado`;
        super(message, 404, true, 'NOT_FOUND');
        this.resource = resource;
    }
}

export default NotFoundError;

