/**
 * CachedRepository — Decorator que agrega caching transparente a cualquier repositorio.
 *
 * Implementa el patrón Decorator para envolver repositorios existentes
 * con una capa de cache in-memory. Las escrituras invalidan el cache automáticamente.
 *
 * Uso:
 *   const courseRepo = new CachedRepository(new SupabaseCourseRepository(db), cacheAdapter, { ttlMs: 600_000 });
 *   const result = await courseRepo.findById(1); // → cache MISS, consulta DB, guarda en cache
 *   const result2 = await courseRepo.findById(1); // → cache HIT, directo de memoria
 */
export class CachedRepository {
    /**
     * @param {object} repo — Repositorio envuelto (debe implementar findById, findAll, etc.).
     * @param {import('../cache/CacheAdapter.js').CacheAdapter} cache — Adaptador de cache.
     * @param {object} [options]
     * @param {number} [options.ttlMs=300000] — TTL del cache en ms (default: 5 min).
     * @param {string} [options.prefix='repo'] — Prefijo para keys del cache.
     */
    constructor(repo, cache, { ttlMs = 300 _000, prefix = 'repo' } = {}) {
        this._repo = repo;
        this._cache = cache;
        this._ttlMs = ttlMs;
        this._prefix = prefix;

        // Proxy: delegar todos los métodos que no cacheamos directamente al repo original
        return new Proxy(this, {
            get: (target, prop) => {
                // Métodos cacheados tienen prioridad
                if (prop in target && typeof target[prop] === 'function') {
                    return target[prop].bind(target);
                }
                // Internal properties
                if (prop.startsWith('_') || prop === 'constructor') {
                    return target[prop];
                }
                // Delegar al repositorio envuelto
                const original = target._repo[prop];
                if (typeof original === 'function') {
                    return original.bind(target._repo);
                }
                return original;
            }
        });
    }

    _key(suffix) {
        return `${this._prefix}:${suffix}`;
    }

    /**
     * findById con cache.
     */
    async findById(id) {
        const cacheKey = this._key(`id:${id}`);
        const cached = this._cache.get(cacheKey);
        if (cached !== null && cached !== undefined) return cached;

        const result = await this._repo.findById(id);
        if (result) {
            this._cache.set(cacheKey, result, this._ttlMs);
        }
        return result;
    }

    /**
     * findAll con cache (solo si no hay filtros complejos).
     */
    async findAll(params) {
        // Solo cachear listados simples (offset+limit sin filtros especiales)
        const cacheKey = this._key(`all:${JSON.stringify(params || {})}`);
        const cached = this._cache.get(cacheKey);
        if (cached !== null && cached !== undefined) return cached;

        const result = await this._repo.findAll(params);
        if (result) {
            this._cache.set(cacheKey, result, this._ttlMs);
        }
        return result;
    }

    /**
     * count con cache (TTL más corto).
     */
    async count(params) {
        const cacheKey = this._key(`count:${JSON.stringify(params || {})}`);
        const cached = this._cache.get(cacheKey);
        if (cached !== null && cached !== undefined) return cached;

        const result = await this._repo.count(params);
        if (result !== undefined) {
            this._cache.set(cacheKey, result, this._ttlMs / 2);
        }
        return result;
    }

    // ── Write operations: invalidate cache ──────────────────

    async create(data) {
        const result = await this._repo.create(data);
        this._invalidateAll();
        return result;
    }

    async update(id, data) {
        const result = await this._repo.update(id, data);
        this._cache.delete(this._key(`id:${id}`));
        this._invalidateAll();
        return result;
    }

    async delete(id) {
        const result = await this._repo.delete(id);
        this._cache.delete(this._key(`id:${id}`));
        this._invalidateAll();
        return result;
    }

    /**
     * Invalida todas las keys de listado/conteo (no hay patrón fácil en Map,
     * pero CacheAdapter es in-memory así que iteramos).
     * @private
     */
    _invalidateAll() {
        // CacheAdapter uses Map internally — clear entries with our prefix
        if (this._cache._store && typeof this._cache._store.keys === 'function') {
            for (const key of[...this._cache._store.keys()]) {
                if (key.startsWith(this._prefix + ':all:') || key.startsWith(this._prefix + ':count:')) {
                    this._cache.delete(key);
                }
            }
        }
    }
}

export default CachedRepository;