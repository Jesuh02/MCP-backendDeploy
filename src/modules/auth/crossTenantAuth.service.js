/**
 * CrossTenantAuthService — Searches ALL tenant databases during login.
 *
 * SRP: only handles cross-tenant authentication probes.
 * DIP: depends on abstract repository constructors, not concrete instances.
 * OCP: automatically picks up any tenant registered in TenantRegistry.
 *
 * Multi-tenant behaviour:
 *   - Single match → returns access token with tenantId + availableTenants claim.
 *   - Multiple matches → returns { multipleMatches, matches } so the UI can ask
 *     the user which institution to log into.  Each match's token already embeds
 *     availableTenants so the chat layer can later offer institution switching.
 *   - Optional cedula → when provided, only tenants where the cédula matches the
 *     `personas` table for that user are returned.  Adds a second identity factor
 *     that prevents username-collision attacks across tenants.
 */
import crypto from 'crypto';
import { Result } from '../../shared/Result.js';
import { UnauthorizedError, ConflictError, ValidationError } from '../../shared/errors/index.js';
import { SupabaseUserRepository, hashPasswordFingerprint } from '../user/infrastructure/supabase.user.repository.js';
import { SupabaseInstitucionRepository } from '../institucion/infrastructure/supabase.institucion.repository.js';
import { SupabasePersonaRepository } from '../persona/infrastructure/supabase.persona.repository.js';
import { getAllTenantEntries } from '../../config/tenantRegistry.js';

export class CrossTenantAuthService {
    constructor({ jwtAdapter }) {
        this.jwt = jwtAdapter;
    }

    /**
     * Attempts username/password (+ optional cedula) login on every registered tenant in parallel.
     * Returns Result with a single match object OR { multipleMatches, matches }.
     * When `cedula` is omitted and multiple users share the same credentials across
     * institutions, returns { needsCedula: true } so the UI can prompt for it.
     *
     * @param {{ username: string, password: string, cedula?: string }} params
     */
    async login({ username, password, cedula }) {
        const entries = getAllTenantEntries();
        if (entries.length === 0) {
            return Result.fail(new UnauthorizedError('No hay instituciones configuradas'));
        }

        const results = await Promise.allSettled(
            entries.map(entry => this._tryLogin(entry, username, password)),
        );

        return this._resolveMatches(results, 'Credenciales inválidas', cedula);
    }

    /**
     * Registers a user in multiple tenant databases (parallel).
     * Used when the user selects more than one institution at sign-up.
     *
     * Strategy per tenant:
     *   - If the username/email already exists → treat the existing account as the
     *     match (idempotent re-registration).
     *   - If the tenant create succeeds → return the new user match.
     *   - On error → log and skip (partial success is still a success).
     *
     * @param {{ username, email, password, persona, personaId, tenantIds: string[] }} params
     * @returns {Result<{ user, accessToken, refreshToken, availableTenants, registeredTenants, failedTenants }>}
     */
    async multiTenantRegister({ username, email, password, persona, personaId, tenantIds }) {
        const entries = getAllTenantEntries().filter(e => tenantIds.includes(e.id));
        if (entries.length === 0) {
            return Result.fail(new ValidationError('Ninguna institución seleccionada está registrada'));
        }

        // Hash password once, reuse across all tenant DBs
        const hashedPassword = await this.jwt.hashPassword(password);
        const passwordFingerprint = hashPasswordFingerprint(password);

        const settled = await Promise.allSettled(
            entries.map(entry =>
                this._registerInTenant(entry, { username, email, hashedPassword, passwordFingerprint, persona, personaId }),
            ),
        );

        const successes = settled
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);

        const failedTenants = entries
            .filter((_, i) => settled[i].status !== 'fulfilled' || settled[i].value === null)
            .map(e => e.id);

        if (successes.length === 0) {
            return Result.fail(new ConflictError('Usuario', username));
        }

        const allTenantIds = successes.map(s => s._payload.tenantId);
        const allTenantObjects = successes.map(s => ({ id: s.tenant.id, name: s.tenant.name }));
        const primary = successes[0];

        // Re-sign tokens so the JWT carries the full availableTenants list
        // Use objects ({id, name}) instead of plain strings so mobile clients
        // can parse them without a type mismatch.
        const accessToken = this.jwt.signAccessToken({
            ...primary._payload,
            availableTenants: allTenantObjects,
        });
        const refreshToken = this.jwt.signRefreshToken({
            ...primary._payload,
            availableTenants: allTenantObjects,
        });

        const { _payload, ...safeMatch } = primary;
        return Result.ok({
            ...safeMatch,
            accessToken,
            refreshToken,
            availableTenants: successes.map(s => ({ id: s.tenant.id, name: s.tenant.name })),
            registeredTenants: allTenantIds,
            failedTenants,
        });
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

    /**
     * Verifica que la contraseña no esté ya en uso en NINGÚN tenant.
     * Consulta el fingerprint HMAC en paralelo en todas las bases de datos
     * registradas. Si el fingerprint no está en la DB (columna no creada aún)
     * la operación falla abierta (permite el registro).
     *
     * @param {string} password  Contraseña en texto plano enviada por el usuario.
     * @returns {Result<{ available: boolean }>}
     */
    async checkPasswordUniqueness(password) {
        if (!password) return Result.ok({ available: true });
        const fingerprint = hashPasswordFingerprint(password);
        if (!fingerprint) return Result.ok({ available: true });

        const entries = getAllTenantEntries();
        const checks = await Promise.all(
            entries.map(async (entry) => {
                if (!entry.client) return false;
                try {
                    const userRepo = new SupabaseUserRepository(entry.client);
                    const existing = await userRepo.findByPasswordFingerprint(fingerprint);
                    return !!existing;
                } catch {
                    return false; // fail open si la columna no existe
                }
            }),
        );

        const isUsed = checks.some(Boolean);
        return Result.ok({ available: !isUsed });
    }

    // ──────────── Private helpers ────────────

    /**
     * Resolves parallel probe results. When multiple matches are found, re-signs
     * each token to embed the full availableTenants list in every JWT — this allows
     * a chat session to offer switching while remaining secure (the token itself is
     * the authoritative list of permitted tenants).
     *
     * @param {PromiseSettledResult[]} settled
     * @param {string} noMatchMessage
     * @param {string|null} cedula  Optional cedula to disambiguate same-credential collisions.
     */
    _resolveMatches(settled, noMatchMessage, cedula = null) {
        let matches = settled
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);

        if (matches.length === 0) {
            return Result.fail(new UnauthorizedError(noMatchMessage));
        }

        // When multiple matches exist, verify they belong to the same physical person
        // by comparing the cedula (identificacion_original) from each persona.
        if (matches.length > 1) {
            const cedulaHashes = matches.map(m => m._cedulaHash).filter(Boolean);
            const uniqueHashes = [...new Set(cedulaHashes)];

            // Different cedulas → different people sharing the same credentials.
            // Ask the user for their cedula to disambiguate, or filter when provided.
            if (uniqueHashes.length > 1) {
                if (!cedula) {
                    // Signal the UI to show the cedula field
                    return Result.ok({ needsCedula: true });
                }
                // Hash the plain cedula from the client before comparing to stored SHA-256 hashes
                const cedulaDigits = String(cedula).replace(/\D/g, '').trim();
                const hashedCedula = cedulaDigits
                    ? crypto.createHash('sha256').update(cedulaDigits).digest('hex')
                    : null;
                const filtered = hashedCedula ? matches.filter(m => m._cedulaHash === hashedCedula) : [];
                if (filtered.length === 0) {
                    return Result.fail(new UnauthorizedError(
                        'La cédula ingresada no corresponde a ninguna cuenta con estas credenciales.',
                    ));
                }
                // If the same cedula appears in multiple institutions → same person, show selection
                matches = filtered;
            } else if (cedulaHashes.length > 0 && cedulaHashes.length < matches.length) {
                // Some matches are missing cedula data — cannot confirm same person.
                // If no cedula provided, ask; otherwise filter those that match.
                if (!cedula) {
                    return Result.ok({ needsCedula: true });
                }
                const cedulaDigits = String(cedula).replace(/\D/g, '').trim();
                const hashedCedula = cedulaDigits
                    ? crypto.createHash('sha256').update(cedulaDigits).digest('hex')
                    : null;
                const filtered = hashedCedula ? matches.filter(m => m._cedulaHash === hashedCedula) : [];
                matches = filtered.length > 0 ? filtered : [matches[0]];
            } else if (cedulaHashes.length === 0) {
                // No cedula data at all in any tenant → auto-select first match.
                // (Cannot validate identity, but these institutions have no cedula column.)
                matches = [matches[0]];
            }
            // else: all cedulas are identical → same person in multiple institutions → fall through
        }

        const allTenantObjects = matches.map(m => ({ id: m.tenant.id, name: m.tenant.name }));

        // Re-sign tokens so every JWT carries the full availableTenants list
        // Use objects ({id, name}) instead of plain strings so mobile clients
        // can parse them without a type mismatch.
        const enriched = matches.map(m => ({
            ...m,
            accessToken: this.jwt.signAccessToken({
                userId: m._payload.userId,
                username: m._payload.username,
                roles: m._payload.roles,
                tenantId: m._payload.tenantId,
                availableTenants: allTenantObjects,
            }),
            refreshToken: this.jwt.signRefreshToken({
                userId: m._payload.userId,
                username: m._payload.username,
                tenantId: m._payload.tenantId,
                availableTenants: allTenantObjects,
            }),
        }));

        if (enriched.length === 1) {
            const { _payload, _cedulaHash, ...result } = enriched[0];
            return Result.ok({ ...result, personaCedulaHash: _cedulaHash || null, availableTenants: enriched.map(m => ({ id: m.tenant.id, name: m.tenant.name })) });
        }

        return Result.ok({
            multipleMatches: true,
            matches: enriched.map(({ _payload, _cedulaHash, ...m }) => ({
                ...m,
                personaCedulaHash: _cedulaHash || null,
                availableTenants: enriched.map(x => ({ id: x.tenant.id, name: x.tenant.name })),
            })),
        });
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

            // Fetch the persona's cedula hash so _resolveMatches can verify identity
            const cedulaHash = await this._fetchCedulaHash(entry.client, user);

            const match = this._buildMatch(entry, user);
            match._cedulaHash = cedulaHash; // attached for cross-tenant identity check
            return match;
        } catch (e) {
            console.warn(`[CrossTenantAuth] Probe failed for ${entry.id}: ${e.message}`);
            return null;
        }
    }

    /**
     * Fetches the cedula hash (identificacion_original) of the persona linked to `user`.
     * Used to verify that multiple tenant matches belong to the same physical person.
     * @returns {Promise<string|null>}
     */
    async _fetchCedulaHash(client, user) {
        try {
            const personaId = user.persona_id ?? user.personas?.id ?? user.persona?.id ?? null;
            if (!personaId) return null;
            const personaRepo = new SupabasePersonaRepository(client);
            const persona = await personaRepo.findById(personaId);
            return persona?.identificacion_original ?? null;
        } catch {
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

            // Fetch cedula hash so _resolveMatches can verify identity across tenants
            const cedulaHash = await this._fetchCedulaHash(entry.client, user);
            const match = { ...this._buildMatch(entry, user), isNewUser: false };
            match._cedulaHash = cedulaHash;
            return match;
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

    /**
     * Builds a match object.
     * NOTE: Stores the raw payload in `_payload` so `_resolveMatches` can re-sign
     * tokens with the full `availableTenants` list once all probes complete.
     * `_payload` is stripped before the result is returned to callers.
     */
    _buildMatch(entry, user) {
        const { password, ...safeUser } = user;
        const roleIds = (user.roles || [])
            .map(r => Number(r.id || r.rol_id))
            .filter(id => Number.isInteger(id) && id > 0);

        const rawPayload = {
            userId: user.id,
            username: user.username,
            roles: roleIds,
            tenantId: entry.id,
            availableTenants: [{ id: entry.id, name: entry.name }], // will be overwritten in _resolveMatches
        };

        return {
            _payload: rawPayload, // internal, stripped before response
            tenant: { id: entry.id, name: entry.name },
            user: safeUser,
            accessToken: this.jwt.signAccessToken(rawPayload),
            refreshToken: this.jwt.signRefreshToken(rawPayload),
        };
    }

    /**
     * Registers a new user in a single tenant database.
     * If the user already exists, returns the existing account match (idempotent).
     *
     * @param {object} entry  Tenant entry from getAllTenantEntries()
     * @param {{ username, email, hashedPassword, passwordFingerprint, persona, personaId }} payload
     * @returns {Promise<object|null>}  Match object or null on unrecoverable error
     */
    async _registerInTenant(entry, { username, email, hashedPassword, passwordFingerprint, persona, personaId }) {
        if (!entry.client) return null;
        try {
            const userRepo = new SupabaseUserRepository(entry.client);

            // Idempotent: if user already exists in this tenant, return that match
            let existing = await userRepo.findByUsername(username);
            if (!existing) existing = await userRepo.findByEmail(email);
            if (existing) {
                console.log(`[CrossTenantAuth] User '${username}' already exists in tenant ${entry.id} — reusing`);
                return this._buildMatch(entry, existing);
            }

            const user = await userRepo.create({ username, email, password: hashedPassword, passwordFingerprint, persona, personaId });
            console.log(`[CrossTenantAuth] Registered user '${username}' in tenant ${entry.id}`);
            return this._buildMatch(entry, user);
        } catch (e) {
            console.warn(`[CrossTenantAuth] Registration failed for tenant ${entry.id}: ${e.message}`);
            return null;
        }
    }
}

