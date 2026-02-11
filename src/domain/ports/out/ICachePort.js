/**
 * ICachePort — Puerto de salida para cache en memoria.
 * @interface
 */
export class ICachePort {
    /**
     * Obtiene un valor del cache.
     * @param {string} key
     * @returns {*|null}
     */
    get(key) { throw new Error('Not implemented'); }

    /**
     * Guarda un valor en cache.
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMs] - Time to live en milisegundos
     */
    set(key, value, ttlMs) { throw new Error('Not implemented'); }

    /**
     * Elimina un valor del cache.
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) { throw new Error('Not implemented'); }

    /**
     * Verifica si una clave existe en cache.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) { throw new Error('Not implemented'); }

    /** Limpia todo el cache. */
    clear() { throw new Error('Not implemented'); }
}
export default ICachePort;