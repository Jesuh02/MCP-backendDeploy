/**
 * ICachePort — Interfaz para adaptadores de cache.
 *
 * Define el contrato para implementaciones de cache (in-memory, Redis, etc.).
 */
export class ICachePort {
    /**
     * Obtiene un valor del cache.
     * @param {string} key
     * @returns {*|null}
     */
    get(key) {
        throw new Error('ICachePort.get() not implemented');
    }

    /**
     * Guarda un valor en cache.
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMs] — TTL en milisegundos.
     */
    set(key, value, ttlMs) {
        throw new Error('ICachePort.set() not implemented');
    }

    /**
     * Elimina un valor del cache.
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) {
        throw new Error('ICachePort.delete() not implemented');
    }

    /**
     * Verifica si existe una key en cache.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        throw new Error('ICachePort.has() not implemented');
    }

    /**
     * Limpia todo el cache.
     */
    clear() {
        throw new Error('ICachePort.clear() not implemented');
    }
}

export default ICachePort;