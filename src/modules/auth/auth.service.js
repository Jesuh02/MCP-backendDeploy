import { Result } from '../../shared/Result.js';
import { UnauthorizedError, ConflictError, ValidationError, NotFoundError, ForbiddenError } from '../../shared/errors/index.js';
import { hashPasswordFingerprint } from '../user/infrastructure/supabase.user.repository.js';
import { getCurrentTenantId, getPrimaryTenantId } from '../../config/tenantRegistry.js';

export class AuthService {
    constructor({ userRepository, jwtAdapter, institucionRepository }) {
        this.userRepo = userRepository;
        this.jwt = jwtAdapter;
        this.institucionRepo = institucionRepository || null;
    }

    async register({ username, email, password, persona, personaId, tenantId }) {
        const existingUser = await this.userRepo.findByUsername(username);
        if (existingUser) return Result.fail(new ConflictError('Usuario', username));

        const existingEmail = await this.userRepo.findByEmail(email);
        if (existingEmail) return Result.fail(new ConflictError('Email', email));

        const hashedPassword = await this.jwt.hashPassword(password);
        const passwordFingerprint = hashPasswordFingerprint(password);
        let user;
        try {
            user = await this.userRepo.create({ username, email, password: hashedPassword, passwordFingerprint, persona, personaId });
        } catch (dbErr) {
            console.error('[AuthService] register DB error:', dbErr.message);
            if (dbErr.message?.includes('usuarios_usuario_key')) {
                return Result.fail(new ConflictError('Usuario', username));
            }
            if (dbErr.message?.includes('usuarios_email_key') || dbErr.message?.includes('duplicate key') && dbErr.message?.includes('email')) {
                return Result.fail(new ConflictError('Email', email));
            }
            return Result.fail(new ValidationError(dbErr.message));
        }

        await this._enrichWithInstitution(user);
        const tokens = this._generateTokens(user, tenantId);
        return Result.ok({ user: this._safeUser(user), ...tokens });
    }
    async login({ username, password }) {
        console.log(`[AuthService] Login attempt for: ${username}`);

        // 1. Try by username
        let user = await this.userRepo.findByUsername(username);

        // 2. If not found, try by email
        if (!user) {
            user = await this.userRepo.findByEmail(username);
        }

        if (!user) {
            console.log(`[AuthService] User/Email '${username}' not found`);
            return Result.fail(new UnauthorizedError('Credenciales inválidas'));
        }

        if (user.isActive === false) {
            console.log(`[AuthService] User '${username}' is deactivated`);
            return Result.fail(new ForbiddenError('Tu usuario ha sido desactivado, por favor contactar a soporte'));
        }

        let valid = false;
        // Check if stored password is a bcrypt hash (starts with $2a$, $2b$, or $2y$)
        const isBcryptHash = user.password && /^\$2[aby]\$/.test(user.password);
        if (isBcryptHash) {
            valid = await this.jwt.comparePassword(password, user.password);
        } else {
            // Fallback: plain-text comparison (for legacy users inserted directly into DB)
            valid = (password === user.password);
            if (valid) {
                // Auto-migrate: hash the plain-text password for future logins
                console.log(`[AuthService] Auto-migrating plain-text password to bcrypt for user '${username}'`);
                try {
                    const hashedPassword = await this.jwt.hashPassword(password);
                    await this.userRepo.update(user.id, { password: hashedPassword });
                    console.log(`[AuthService] Password migration successful for '${username}'`);
                } catch (migrationErr) {
                    console.error(`[AuthService] Password migration failed for '${username}':`, migrationErr.message);
                }
            }
        }
        if (!valid) {
            console.log(`[AuthService] Password validation failed for '${username}'`);
            return Result.fail(new UnauthorizedError('Credenciales inválidas'));
        }

        await this._enrichWithInstitution(user);
        const tokens = this._generateTokens(user, getCurrentTenantId() || getPrimaryTenantId());
        return Result.ok({ user: this._safeUser(user), ...tokens });
    }

    async refreshToken(refreshToken) {
        try {
            const result = this.jwt.verifyRefreshToken(refreshToken);
            if (!result.valid) return Result.fail(new UnauthorizedError('Refresh token inválido'));
            const user = await this.userRepo.findById(result.decoded.userId);
            if (!user) return Result.fail(new UnauthorizedError('Usuario no encontrado'));
            if (user.isActive === false) return Result.fail(new ForbiddenError('Tu usuario ha sido desactivado, por favor contactar a soporte'));
            const tokens = this._generateTokens(user, result.decoded.tenantId);
            return Result.ok(tokens);
        } catch {
            return Result.fail(new UnauthorizedError('Refresh token inválido'));
        }
    }

    async changePassword(userId, { currentPassword, newPassword }) {
        const user = await this.userRepo.findById(userId);
        if (!user) return Result.fail(new UnauthorizedError('Usuario no encontrado'));

        const valid = await this.jwt.comparePassword(currentPassword, user.password);
        if (!valid) return Result.fail(new UnauthorizedError('Contraseña actual incorrecta'));

        const hashed = await this.jwt.hashPassword(newPassword);
        await this.userRepo.update(userId, { password: hashed });
        return Result.ok({ message: 'Contraseña actualizada' });
    }

    _generateTokens(user, tenantId) {
        if (!tenantId) tenantId = getCurrentTenantId() || getPrimaryTenantId() || 'qa-develop';
        // Asegurar que roles sean IDs numéricos para comparación correcta en requireRoles
        const roleIds = (user.roles || []).map(r => Number(r.id || r.rol_id)).filter(id => Number.isInteger(id) && id > 0);
        const effectiveTenant = tenantId || 'qa-develop';
        const tenantName = effectiveTenant; // name not available here; mobile decode handles id-only
        const payload = { userId: user.id, username: user.username, roles: roleIds, tenantId: effectiveTenant, availableTenants: [{ id: effectiveTenant, name: tenantName }] };
        return {
            accessToken: this.jwt.signAccessToken(payload),
            refreshToken: this.jwt.signRefreshToken(payload),
        };
    }

    _safeUser(user) {
        const { password, ...safe } = user;
        return safe;
    }

    /** Enrich user object with institution details from persona.institucion_id */
    async _enrichWithInstitution(user) {
        if (!this.institucionRepo || !user) return user;
        const persona = user.persona ?? user.personas ?? null;
        const institucionId = persona?.institucion_id ?? null;
        if (!institucionId) return user;
        try {
            const inst = await this.institucionRepo.findById(institucionId);
            if (inst) user.institucion = inst;
        } catch (e) {
            console.warn('[AuthService] Could not enrich institution:', e.message);
        }
        return user;
    }

    /**
     * Login with Google - finds or creates user by email and returns JWT tokens.
     * This ensures the Android client gets proper authentication for the correct user.
     */
    async loginWithGoogle({ email, displayName, avatarUrl, username }) {
        console.log(`[AuthService] Google login attempt for email: ${email}`);

        // 1. Find user by email
        let user = await this.userRepo.findByEmail(email);

        if (user) {
            console.log(`[AuthService] Found existing user for Google email: ${email}, userId: ${user.id}, username: ${user.username}`);

            if (user.isActive === false) {
                console.log(`[AuthService] Google user '${email}' is deactivated`);
                return Result.fail(new ForbiddenError('Tu usuario ha sido desactivado, por favor contactar a soporte'));
            }

            // Update avatar if provided and different
            if (avatarUrl && user.avatar !== avatarUrl) {
                try {
                    await this.userRepo.update(user.id, { avatar: avatarUrl });
                    user.avatar = avatarUrl;
                    console.log(`[AuthService] Updated avatar for user ${user.id}`);
                } catch (e) {
                    console.warn(`[AuthService] Could not update avatar: ${e.message}`);
                }
            }

            await this._enrichWithInstitution(user);
            const tokens = this._generateTokens(user);
            return Result.ok({ user: this._safeUser(user), ...tokens, isNewUser: false });
        }

        // 2. Email not found — if a username hint is provided, try linking Google email to that account
        if (username && username.trim().length >= 3) {
            const existingUser = await this.userRepo.findByUsername(username.trim());
            if (existingUser) {
                if (existingUser.isActive === false) {
                    console.log(`[AuthService] Google linked user '${username}' is deactivated`);
                    return Result.fail(new ForbiddenError('Tu usuario ha sido desactivado, por favor contactar a soporte'));
                }
                // Only link when the account has no email (avoids overwriting a different verified email)
                if (!existingUser.email) {
                    try {
                        await this.userRepo.update(existingUser.id, { email });
                        existingUser.email = email;
                        console.log(`[AuthService] Linked Google email ${email} to existing user '${existingUser.username}' (id: ${existingUser.id})`);
                    } catch (e) {
                        console.warn(`[AuthService] Could not link email to user '${existingUser.username}': ${e.message}`);
                    }
                } else {
                    console.log(`[AuthService] Username hint '${username}' found but already has email '${existingUser.email}', skipping link`);
                }

                // Update avatar if provided
                if (avatarUrl && existingUser.avatar !== avatarUrl) {
                    try {
                        await this.userRepo.update(existingUser.id, { avatar: avatarUrl });
                        existingUser.avatar = avatarUrl;
                    } catch (e) {
                        console.warn(`[AuthService] Could not update avatar: ${e.message}`);
                    }
                }

                await this._enrichWithInstitution(existingUser);
                const tokens = this._generateTokens(existingUser);
                return Result.ok({ user: this._safeUser(existingUser), ...tokens, isNewUser: false });
            }
        }

        // 3. User doesn't exist — redirect to registration
        console.log(`[AuthService] No user found for Google email: ${email}, requires registration`);
        return Result.fail(new NotFoundError('Usuario', email));
    }
}
export default AuthService;

