/**
 * AuthMiddleware — Middleware Express para autenticación JWT.
 *
 * Verifica el token Bearer en el header Authorization, inyecta req.user
 * con { userId, username, roles } y rechaza con 401 si es inválido.
 *
 * Rutas públicas (sin autenticación) se configuran al crear el middleware.
 * Las rutas bajo /api/v1/public/* son públicas por convención (browsing/discovery).
 */
import { UnauthorizedError } from '../errors/index.js';

/** Rutas que NO requieren autenticación */
const DEFAULT_PUBLIC_PATHS = [
    '/health',
    '/_health',
    '/ping-debug',
    '/debug-env',
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/refresh-token',
    '/api/v1/public',
];

/**
 * Crea el middleware de autenticación.
 * @param {import('../../infrastructure/auth/JWTAdapter.js').JWTAdapter} jwtAdapter
 * @param {string[]} [extraPublicPaths] — rutas públicas adicionales.
 * @returns {import('express').RequestHandler}
 */
export function createAuthMiddleware(jwtAdapter, extraPublicPaths = []) {
    const publicPaths = [...DEFAULT_PUBLIC_PATHS, ...extraPublicPaths];

    return (req, _res, next) => {
        // ── Rutas públicas ──
        // Usamos originalUrl para obtener la ruta completa (incluyendo /api/v1)
        // y eliminamos query params si existen.
        const fullPath = req.originalUrl.split('?')[0];

        // Whitelist: rutas explícitamente públicas (browsing, auth, health)
        if (publicPaths.some((p) => fullPath === p || fullPath.startsWith(p + '/'))) {
            return next();
        }

        // Convención: cualquier ruta bajo /api/v1/public/ es pública por diseño
        if (fullPath.startsWith('/api/v1/public/') || fullPath === '/api/v1/public') {
            return next();
        }

        // Permitir rutas legacy que no estén bajo /api/v1
        if (!fullPath.startsWith('/api/v1')) {
            return next();
        }

        // ── Extraer token ──
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            const err = new UnauthorizedError('Token de autenticación requerido');
            err.silent = true; // No loguear warning — ya es manejado por IdempotencyMiddleware
            return next(err);
        }

        const token = authHeader.slice(7);
        const { valid, decoded, error } = jwtAdapter.verifyAccessToken(token);

        if (!valid) {
            return next(new UnauthorizedError(`Token inválido: ${error}`));
        }

        // ── Inyectar usuario autenticado ──
        req.user = {
            userId: decoded.userId,
            username: decoded.username,
            roles: decoded.roles || [],
        };

        next();
    };
}

/**
 * Middleware de autenticación opcional (soft auth).
 * Intenta extraer y validar el JWT si está presente, inyecta req.user.
 * Si NO hay token o es inválido, simplemente continúa sin req.user.
 *
 * Útil para endpoints como payment/initiate donde:
 *   - Si hay JWT → lo usamos (más seguro)
 *   - Si no hay JWT → el controlador puede usar userId del body como fallback
 *
 * @param {import('../../infrastructure/auth/JWTAdapter.js').JWTAdapter} jwtAdapter
 * @returns {import('express').RequestHandler}
 */
export function createOptionalAuthMiddleware(jwtAdapter) {
    return (req, _res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next(); // No token — proceed without req.user
        }

        const token = authHeader.slice(7);
        const { valid, decoded } = jwtAdapter.verifyAccessToken(token);

        if (valid && decoded) {
            req.user = {
                userId: decoded.userId,
                username: decoded.username,
                roles: decoded.roles || [],
            };
        }

        next();
    };
}

/**
 * Middleware para verificar roles específicos.
 * @param  {...number} requiredRoles — IDs de roles permitidos (ej: 1=estudiante, 2=docente, 3=admin).
 * @returns {import('express').RequestHandler}
 */
export function requireRoles(...requiredRoles) {
    return (req, _res, next) => {
        if (!req.user) {
            return next(new UnauthorizedError('Autenticación requerida'));
        }

        const userRoles = req.user.roles || [];
        const hasRole = requiredRoles.some((r) => userRoles.includes(r));

        if (!hasRole) {
            const err = new UnauthorizedError('No tienes permisos para esta acción');
            err.statusCode = 403;
            err.code = 'FORBIDDEN';
            return next(err);
        }

        next();
    };
}

export default { createAuthMiddleware, createOptionalAuthMiddleware, requireRoles };

