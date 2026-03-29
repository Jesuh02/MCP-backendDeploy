/**
 * CrossTenantAuthService — Searches ALL tenant databases during login.
 *
 * SRP: only handles cross-tenant authentication probes.
 * DIP: depends on abstract repository constructors, not concrete instances.
 * OCP: automatically picks up any tenant registered in TenantRegistry.
 */
import { Result } from '../../shared/Result.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { SupabaseUserRepository } from '../user/infrastructure/supabase.user.repository.js';
import { SupabaseInstitucionRepository } from '../institucion/infrastructure/supabase.institucion.repository.js';
import { getAllTenantEntries } from '../../config/tenantRegistry.js';

export class CrossTenantAuthService {
    constructor({ jwtAdapter }) {
        this.jwt = jwtAdapter;
    }

    /**
     * Attempts username/password login on every registered tenant in parallel.
     * Returns Result with a single match object OR { multipleMatches, matches }.
     */
    async login({ username, password }) {
        const entries = getAllTenantEntries();
        if (entries.length === 0) {
            return Result.fail(new UnauthorizedError('No hay instituciones configuradas'));
        }

        const results = await Promise.allSettled(
            entries.map(entry => this._tryLogin(entry, username, password)),
        );

        return this._resolveMatches(results, 'Credenciales inválidas');
    }

    /**
     * Attempts Google login on every registered tenant in parallel.
     */
    async googleLogin({ email, displayName, avatarUrl, username }) {
        const entries = getAllTenantEntries();
        if (entries.length === 0) {
            return Result.fail(new UnauthorizedError('No hay instituciones configuradas'));
        }

        const results = await Promise.allSettled(
            entries.map(entry => this._tryGoogleLogin(entry, { email, displayName, avatarUrl, username })),
        );

        return this._resolveMatches(results, 'Usuario no encontrado en ninguna institución');
    }

    // ──────────── Private helpers ────────────

    _resolveMatches(settled, noMatchMessage) {
            const matches = settled
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => r.value);

            if (matches.length === 0) {
                return Result.fail(new UnauthorizedError(noMatchMessage));
            }
            if (matches.length === 1) {
            return Result.ok(matches[0]);
        }
        return Result.ok({ multipleMatches: true, matches });
    }

    async _tryLogin(entry, username, password) {
        if (!entry.client) return null;
        try {
            const userRepo = new SupabaseUserRepository(entry.client);
            const instRepo = new SupabaseInstitucionRepository(entry.client);

            let user = await userRepo.findByUsername(username);
            if (!user) user = await userRepo.findByEmail(username);
            if (!user || user.isActive === false) return null;

            const valid = await this._verifyPassword(userRepo, user, password);
            if (!valid) return null;

            await this._enrichWithInstitution(user, instRepo);
            return this._buildMatch(entry, user);
        } catch (e) {
            console.warn(`[CrossTenantAuth] Probe failed for ${entry.id}: ${e.message}`);
            return null;
        }
    }

    async _tryGoogleLogin(entry, { email, displayName, avatarUrl, username }) {
        if (!entry.client) return null;
        try {
            const userRepo = new SupabaseUserRepository(entry.client);
            const instRepo = new SupabaseInstitucionRepository(entry.client);

            let user = await userRepo.findByEmail(email);
            if (!user && username?.trim()?.length >= 3) {
                user = await userRepo.findByUsername(username.trim());
            }
            if (!user || user.isActive === false) return null;

            if (avatarUrl && user.avatar !== avatarUrl) {
                try { await userRepo.update(user.id, { avatar: avatarUrl }); user.avatar = avatarUrl; } catch { /* ignore */ }
            }

            await this._enrichWithInstitution(user, instRepo);
            return { ...this._buildMatch(entry, user), isNewUser: false };
        } catch (e) {
            console.warn(`[CrossTenantAuth] Google probe failed for ${entry.id}: ${e.message}`);
            return null;
        }
    }

    async _verifyPassword(userRepo, user, password) {
        const isBcrypt = user.password && /^\$2[aby]\$/.test(user.password);
        if (isBcrypt) {
            return this.jwt.comparePassword(password, user.password);
        }
        // Legacy plain-text: auto-migrate to bcrypt on success
        const valid = password === user.password;
        if (valid) {
            try {
                const hashed = await this.jwt.hashPassword(password);
                await userRepo.update(user.id, { password: hashed });
            } catch { /* non-fatal */ }
        }
        return valid;
    }

    async _enrichWithInstitution(user, instRepo) {
        const persona = user.persona ?? user.personas ?? null;
        const institucionId = persona?.institucion_id ?? null;
        if (!institucionId) return;
        try {
            const inst = await instRepo.findById(institucionId);
            if (inst) user.institucion = inst;
        } catch { /* ignore */ }
    }

    _buildMatch(entry, user) {
        const { password, ...safeUser } = user;
        const roleIds = (user.roles || [])
            .map(r => Number(r.id || r.rol_id))
            .filter(id => Number.isInteger(id) && id > 0);

        const payload = {
            userId: user.id,
            username: user.username,
            roles: roleIds,
            tenantId: entry.id,
        };

        return {
            tenant: { id: entry.id, name: entry.name },
            user: safeUser,
            accessToken: this.jwt.signAccessToken(payload),
            refreshToken: this.jwt.signRefreshToken(payload),
        };
    }
}
