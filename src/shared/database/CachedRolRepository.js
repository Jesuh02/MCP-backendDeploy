/**
 * CachedRolRepository — Cache-aside decorator para SupabaseRolRepository.
 *
 * Cachea lecturas frecuentes de roles y permisos (datos maestros que rara
 * vez cambian). Las escrituras invalidan el cache automáticamente.
 */
export class CachedRolRepository {
    constructor(repo, cache, { ttlMs = 1_800_000, prefix = 'rol' } = {}) {
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

    async findAllRoles() {
        const k = this._key('allRoles');
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.findAllRoles();
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async findRolById(id) {
        const k = this._key(`rolId:${id}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.findRolById(id);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async findUserRoleIds(userId) {
        const k = this._key(`userRoles:${userId}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.findUserRoleIds(userId);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async userHasRole(userId, roleId) {
        const k = this._key(`hasRole:${userId}:${roleId}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.userHasRole(userId, roleId);
        this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async isUserDocente(userId) {
        const k = this._key(`docente:${userId}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.isUserDocente(userId);
        this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async findRecursosByRol(rolId) {
        const k = this._key(`recursos:${rolId}`);
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.findRecursosByRol(rolId);
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    async findAllRecursos() {
        const k = this._key('allRecursos');
        const cached = this._cache.get(k);
        if (cached !== null && cached !== undefined) return cached;
        const result = await this._repo.findAllRecursos();
        if (result) this._cache.set(k, result, this._ttlMs);
        return result;
    }

    // ── Writes: invalidate cache ──
    async promoteToDocente(userId) {
        const result = await this._repo.promoteToDocente(userId);
        this._invalidateUser(userId);
        return result;
    }

    _invalidateUser(userId) {
        this._cache.delete(this._key(`userRoles:${userId}`));
        this._cache.delete(this._key(`docente:${userId}`));
        // Invalidate all hasRole keys for this user
        if (this._cache._store && typeof this._cache._store.keys === 'function') {
            for (const key of [...this._cache._store.keys()]) {
                if (key.startsWith(`${this._prefix}:hasRole:${userId}:`)) {
                    this._cache.delete(key);
                }
            }
        }
    }
}

export default CachedRolRepository;
