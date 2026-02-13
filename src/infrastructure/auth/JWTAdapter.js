/**
 * JWTAdapter — Adaptador de infraestructura para manejo de JSON Web Tokens.
 *
 * Responsabilidades:
 *   - Firmar access tokens y refresh tokens.
 *   - Verificar y decodificar tokens.
 *   - Hash / comparación de contraseñas con bcrypt.
 *
 * Principio SOLID: Single Responsibility — solo gestiona autenticación criptográfica.
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || 'coursev-default-secret-change-me';
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET || ACCESS_TOKEN_SECRET + '-refresh';
const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRY || '3650d';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '3650d';
const SALT_ROUNDS = 10;

export class JWTAdapter {
    // ─── Token Generation ───────────────────────────────────

    /**
     * Genera un access token.
     * @param {{ userId: number, username: string, roles: number[] }} payload
     * @returns {string} JWT firmado.
     */
    signAccessToken(payload) {
        return jwt.sign({
                userId: payload.userId,
                username: payload.username,
                roles: payload.roles || [],
                type: 'access',
            },
            ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY }
        );
    }

    /**
     * Genera un refresh token.
     * @param {{ userId: number, username: string }} payload
     * @returns {string}
     */
    signRefreshToken(payload) {
            return jwt.sign({
                    userId: payload.userId,
                    username: payload.username,
                    type: 'refresh',
                },
                REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY }
            );
        }
        // ─── Token Verification ─────────────────────────────────

    /**
     * Verifica un access token.
     * @param {string} token
     * @returns {{ valid: boolean, decoded: object|null, error: string|null }}
     */
    verifyAccessToken(token) {
        try {
            const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
            return { valid: true, decoded, error: null };
        } catch (err) {
            // Fix: Permitir tokens expirados para mantener sesión activa (Requerimiento usuario)
            if (err.name === 'TokenExpiredError') {
                try {
                    const decodedExpired = jwt.verify(token, ACCESS_TOKEN_SECRET, { ignoreExpiration: true });
                    return { valid: true, decoded: decodedExpired, error: null };
                } catch (e) {
                    // Falló validación de firma
                }
            }
            return { valid: false, decoded: null, error: err.message };
        }
    }

    /**
     * Verifica un refresh token.
     * @param {string} token
     * @returns {{ valid: boolean, decoded: object|null, error: string|null }}
     */
    verifyRefreshToken(token) {
        try {
            const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET);
            return { valid: true, decoded, error: null };
        } catch (err) {
            return { valid: false, decoded: null, error: err.message };
        }
    }

    /**
     * Decodifica sin verificar (útil para leer payload expirado).
     * @param {string} token
     * @returns {object|null}
     */
    decode(token) {
        return jwt.decode(token);
    }

    // ─── Password Hashing ───────────────────────────────────

    /**
     * Genera hash de contraseña.
     * @param {string} plainPassword
     * @returns {Promise<string>}
     */
    async hashPassword(plainPassword) {
        return bcrypt.hash(plainPassword, SALT_ROUNDS);
    }

    /**
     * Compara contraseña plana contra hash.
     * @param {string} plainPassword
     * @param {string} hashedPassword
     * @returns {Promise<boolean>}
     */
    async comparePassword(plainPassword, hashedPassword) {
        return bcrypt.compare(plainPassword, hashedPassword);
    }
}

export default JWTAdapter;