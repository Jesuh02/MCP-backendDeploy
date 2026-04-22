/**
 * CachedCourseReadRepository — Cache-aside decorator para SupabaseCourseReadRepository.
 *
 * Cachea las queries de catálogo/listado (CQRS read model). TTL corto porque
 * los listados cambian con más frecuencia que los datos maestros.
 */
export class CachedCourseReadRepository {
    constructor(repo, cache, { ttlMs = 300_000, prefix = 'courseRead' } = {}) {
        this._repo = repo;
        this._cache = cache;
        this._ttlMs = ttlMs;
        this._prefix = prefix;

        return new Proxy(this, {
            get: (target, prop) => {
                if (prop in target && typeof target[prop] === 'function') {
                    return target[prop].bind(target);
                }
                if (prop.startsWith('_') || prop === 'constructor') {
                    return target[prop];
                }
                const original = target._repo[prop];
                if (typeof original === 'function') {
                    return original.bind(target._repo);
                }
                return original;
            }
        });
    }

    _key(suffix) { return `${this._prefix}:${suffix}`; }

    async listForCatalog(params = {}) {
        const k = this._key(`catalog:${JSON.stringify(params)}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.listForCatalog(params);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async searchForCatalog(searchQuery, params = {}) {
        const k = this._key(`search:${searchQuery}:${JSON.stringify(params)}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.searchForCatalog(searchQuery, params);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async listForStudent(courseIds) {
        if (!courseIds || courseIds.length === 0) return [];
        const sorted = [...courseIds].sort();
        const k = this._key(`student:${sorted.join(',')}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.listForStudent(courseIds);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async listFreeForCatalog(params = {}) {
        const k = this._key(`free:${JSON.stringify(params)}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.listFreeForCatalog(params);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async listPremiumForCatalog(params = {}) {
        const k = this._key(`premium:${JSON.stringify(params)}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.listPremiumForCatalog(params);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async findByIdsLightweight(ids) {
        if (!ids || ids.length === 0) return [];
        const sorted = [...ids].sort();
        const k = this._key(`ids:${sorted.join(',')}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.findByIdsLightweight(ids);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    /**
     * Invalida todas las entradas de este prefijo.
     * Llamar desde el servicio cuando se crea/actualiza/elimina un curso.
     */
    invalidateAll() {
        if (this._cache._store && typeof this._cache._store.keys === 'function') {
            for (const key of [...this._cache._store.keys()]) {
                if (key.startsWith(this._prefix + ':')) {
                    this._cache.delete(key);
                }
            }
        }
    }
}

export default CachedCourseReadRepository;
