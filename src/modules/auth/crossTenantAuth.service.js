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
import bcrypt from 'bcryptjs';
import { Result } from '../../shared/Result.js';
import { UnauthorizedError, ConflictError, ValidationError, ForbiddenError } from '../../shared/errors/index.js';
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
     * Accepts an optional cedula to disambiguate when the same email belongs to
     * different people across institutions.
     */
    async googleLogin({ email, displayName, avatarUrl, username, cedula }) {
        const entries = getAllTenantEntries();
        if (entries.length === 0) {
            return Result.fail(new UnauthorizedError('No hay instituciones configuradas'));
        }

        const results = await Promise.allSettled(
            entries.map(entry => this._tryGoogleLogin(entry, { email, displayName, avatarUrl, username })),
        );

        return this._resolveMatches(results, 'Usuario no encontrado en ninguna institución', cedula);
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
        // Detectar errores de usuario desactivado/suspendido — tienen prioridad sobre cualquier match
        const forbiddenError = settled
            .filter(r => r.status === 'rejected')
            .map(r => r.reason)
            .find(e => e instanceof ForbiddenError);

        // Institution suspension / user deactivation ALWAYS blocks login,
        // even if the same credentials match an active institution elsewhere.
        if (forbiddenError) return Result.fail(forbiddenError);

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
                // Compare user-provided cedula against stored values.
                // _cedulaHash can be: (a) numeric cedula string like "1006617028",
                // (b) SHA-256 hash, or (c) legacy non-numeric value.
                // Try direct digit match first, then SHA-256 hash match as fallback.
                const cedulaDigits = String(cedula).replace(/\D/g, '').trim();
                const hashedCedula = cedulaDigits
                    ? crypto.createHash('sha256').update(cedulaDigits).digest('hex')
                    : null;
                const filtered = matches.filter(m => {
                    if (!m._cedulaHash) return false;
                    // Direct numeric match (when _cedulaHash is the numeric cedula)
                    if (cedulaDigits && m._cedulaHash === cedulaDigits) return true;
                    // SHA-256 hash match (when _cedulaHash is a hash stored in identificacion_original)
                    if (hashedCedula && m._cedulaHash === hashedCedula) return true;
                    return false;
                });
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
                const filtered = matches.filter(m => {
                    if (!m._cedulaHash) return false;
                    if (cedulaDigits && m._cedulaHash === cedulaDigits) return true;
                    if (hashedCedula && m._cedulaHash === hashedCedula) return true;
                    return false;
                });
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
            if (!user) return null;

            if (user.isActive === false) {
                throw new ForbiddenError('Su usuario ha sido desactivado, porfavor contactar con soporte');
            }

            const valid = await this._verifyPassword(userRepo, user, password);
            if (!valid) return null;

            await this._enrichWithInstitution(user, instRepo);

            // Block login if the institution is suspended
            if (user.institucion?.is_suspended) {
                throw new ForbiddenError(
                    'Tu institución ha sido suspendida. Contacta al administrador.',
                );
            }

            // Fetch the persona's cedula hash so _resolveMatches can verify identity
            const cedulaHash = await this._fetchCedulaHash(entry.client, user);

            const match = this._buildMatch(entry, user);
            match._cedulaHash = cedulaHash; // attached for cross-tenant identity check
            return match;
        } catch (e) {
            if (e instanceof ForbiddenError) throw e; // propagar error de usuario desactivado
            console.warn(`[CrossTenantAuth] Probe failed for ${entry.id}: ${e.message}`);
            return null;
        }
    }

    /**
     * Fetches the cedula (identificacion) of the persona linked to `user`.
     * Prefers the numeric `identificacion` field (the real cedula number) over
     * `identificacion_original` which may contain a SHA-256 hash or a legacy
     * non-numeric value like "jesus" or "jesus_duplicate_5".
     * Used to verify that multiple tenant matches belong to the same physical person.
     * @returns {Promise<string|null>}
     */
    async _fetchCedulaHash(client, user) {
        try {
            const personaId = user.persona_id ?? user.personas?.id ?? user.persona?.id ?? null;
            if (!personaId) return null;
            const personaRepo = new SupabasePersonaRepository(client);
            const persona = await personaRepo.findById(personaId);
            if (!persona) return null;
            // Prefer the numeric identificacion field (actual cedula number)
            const identificacion = persona.identificacion;
            if (identificacion && Number.isFinite(Number(identificacion)) && Number(identificacion) > 0) {
                return String(identificacion);
            }
            // Fallback to identificacion_original (may be SHA-256 hash or legacy value)
            return persona.identificacion_original ?? null;
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
            if (!user) return null;

            if (user.isActive === false) {
                throw new ForbiddenError('Su usuario ha sido desactivado, porfavor contactar con soporte');
            }

            if (avatarUrl && user.avatar !== avatarUrl) {
                try { await userRepo.update(user.id, { avatar: avatarUrl }); user.avatar = avatarUrl; } catch { /* ignore */ }
            }

            await this._enrichWithInstitution(user, instRepo);

            // Block login if the institution is suspended
            if (user.institucion?.is_suspended) {
                throw new ForbiddenError(
                    'Tu institución ha sido suspendida. Contacta al administrador.',
                );
            }

            // Fetch cedula hash so _resolveMatches can verify identity across tenants
            const cedulaHash = await this._fetchCedulaHash(entry.client, user);
            const match = { ...this._buildMatch(entry, user), isNewUser: false };
            match._cedulaHash = cedulaHash;
            return match;
        } catch (e) {
            if (e instanceof ForbiddenError) throw e; // propagar error de usuario desactivado
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

    // ─────────────────────────────────────────────────────────────────────────
    // Password Reset (in-memory store with 30-min TTL)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Generates a 4-digit code, stores it for 30 min, and sends it by email.
     * Always resolves (never throws) so callers can fire-and-forget for security.
     */
    async sendPasswordReset(email, emailAdapter) {
        const normalizedEmail = email.trim().toLowerCase();
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const expiresAt = Date.now() + 30 * 60 * 1000;

        // Find the user across all tenants
        let foundUserId = null;
        let foundTenantId = null;
        const entries = getAllTenantEntries();
        for (const entry of entries) {
            if (!entry.client) continue;
            try {
                const userRepo = new SupabaseUserRepository(entry.client);
                const user = await userRepo.findByEmail(normalizedEmail);
                if (user) {
                    foundUserId = user.id;
                    foundTenantId = entry.id;
                    break;
                }
            } catch (e) {
                console.warn(`[CrossTenantAuth] sendPasswordReset probe failed for tenant ${entry.id}: ${e.message}`);
            }
        }

        // Store code regardless of whether user was found (security: always store+send)
        _resetStore.set(normalizedEmail, { code, expiresAt, userId: foundUserId, tenantId: foundTenantId });
        setTimeout(() => _resetStore.delete(normalizedEmail), 30 * 60 * 1000);

        if (!emailAdapter) {
            console.warn('[CrossTenantAuth] sendPasswordReset: no emailAdapter configured');
            return;
        }

        try {
            await emailAdapter.sendEmail({
                to: normalizedEmail,
                subject: 'Código de recuperación de contraseña',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;background:#1A1A2E;color:#fff;border-radius:12px">
                        <h2 style="color:#8B5CF6;margin-bottom:8px">Recuperación de contraseña</h2>
                        <p style="color:#94A3B8">Usa el siguiente código para restablecer tu contraseña. Este código es válido por <strong style="color:#fff">30 minutos</strong>.</p>
                        <div style="background:#16213E;border:2px solid #8B5CF6;border-radius:10px;padding:20px;text-align:center;margin:24px 0">
                            <span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#8B5CF6">${code}</span>
                        </div>
                        <p style="color:#EF4444;font-size:13px">Si no solicitaste este código, ignora este correo.</p>
                    </div>`,
            });
            console.log(`[CrossTenantAuth] Reset code sent to ${normalizedEmail}`);
        } catch (e) {
            console.error(`[CrossTenantAuth] Failed to send reset email to ${normalizedEmail}: ${e.message}`);
        }
    }

    /**
     * Returns true if the code is valid and not expired.
     */
    async verifyPasswordResetCode(email, code) {
        const normalizedEmail = email.trim().toLowerCase();
        const entry = _resetStore.get(normalizedEmail);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) { _resetStore.delete(normalizedEmail); return false; }
        return entry.code === String(code);
    }

    /**
     * Verifies the code and updates the password in the correct tenant DB.
     */
    async resetPassword(email, code, newPassword) {
        const normalizedEmail = email.trim().toLowerCase();
        const valid = await this.verifyPasswordResetCode(normalizedEmail, code);
        if (!valid) throw new Error('Código inválido o expirado');

        const entry = _resetStore.get(normalizedEmail);
        if (!entry?.tenantId || !entry?.userId) throw new Error('No se encontró información del usuario');

        const tenantEntries = getAllTenantEntries();
        const tenantEntry = tenantEntries.find(e => e.id === entry.tenantId);
        if (!tenantEntry?.client) throw new Error('Tenant no disponible');

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const userRepo = new SupabaseUserRepository(tenantEntry.client);
        await userRepo.update(entry.userId, { password: hashedPassword });

        _resetStore.delete(normalizedEmail);
        console.log(`[CrossTenantAuth] Password reset for user ${entry.userId} in tenant ${entry.tenantId}`);
    }
}

/** In-memory store: email → { code, expiresAt, userId, tenantId } */
const _resetStore = new Map();

