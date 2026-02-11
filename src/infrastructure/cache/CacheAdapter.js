/**
 * CacheAdapter — Adaptador de infraestructura que implementa ICachePort.
 *
 * Envuelve CacheService existente (LRU en memoria) detrás de un puerto abstracto.
 */

export class CacheAdapter {
    constructor() {
        this._store = new Map();
        this._ttls = new Map();
        console.log('✅ CacheAdapter: inicializado (in-memory LRU)');
    }

    /**
     * @param {string} key
     * @returns {*|null}
     */
    get(key) {
        if (!this._store.has(key)) return null;

        // Check TTL
        const expiry = this._ttls.get(key);
        if (expiry && Date.now() > expiry) {
            this._store.delete(key);
            this._ttls.delete(key);
            return null;
        }
        return this._store.get(key);
    }

    /**
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMs]
     */
    set(key, value, ttlMs) {
        this._store.set(key, value);
        if (ttlMs) {
            this._ttls.set(key, Date.now() + ttlMs);
        }
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) {
            this._ttls.delete(key);
            return this._store.delete(key);
        }
        /**
         * @param {string} key
         * @returns {boolean}
         */
    has(key) {
        const val = this.get(key); // triggers TTL check
        return val !== null;
    }

    /** Limpia todo el cache. */
    clear() {
        this._store.clear();
        this._ttls.clear();
    }
}
export default CacheAdapter;