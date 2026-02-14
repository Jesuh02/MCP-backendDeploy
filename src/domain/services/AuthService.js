import { Result } from '../../shared/Result.js';
import { UnauthorizedError, ConflictError, ValidationError } from '../../shared/errors/index.js';

export class AuthService {
    constructor({ userRepository, jwtAdapter }) {
        this.userRepo = userRepository;
        this.jwt = jwtAdapter;
    }

    async register({ username, email, password, persona }) {
        const existingUser = await this.userRepo.findByUsername(username);
        if (existingUser) return Result.fail(new ConflictError('Usuario', username));

        const existingEmail = await this.userRepo.findByEmail(email);
        if (existingEmail) return Result.fail(new ConflictError('Email', email));

        const hashedPassword = await this.jwt.hashPassword(password);
        const user = await this.userRepo.create({ username, email, password: hashedPassword, persona });

        const tokens = this._generateTokens(user);
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

        const tokens = this._generateTokens(user);
        return Result.ok({ user: this._safeUser(user), ...tokens });
    }

    async refreshToken(refreshToken) {
        try {
            const result = this.jwt.verifyRefreshToken(refreshToken);
            if (!result.valid) return Result.fail(new UnauthorizedError('Refresh token inválido'));
            const user = await this.userRepo.findById(result.decoded.userId);
            if (!user) return Result.fail(new UnauthorizedError('Usuario no encontrado'));
            const tokens = this._generateTokens(user);
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

    _generateTokens(user) {
        const payload = { userId: user.id, username: user.username, roles: (user.roles || []).map(r => r.id || r.rol_id) };
        return {
            accessToken: this.jwt.signAccessToken(payload),
            refreshToken: this.jwt.signRefreshToken(payload),
        };
    }

    _safeUser(user) {
        const { password, ...safe } = user;
        return safe;
    }
}
export default AuthService;

