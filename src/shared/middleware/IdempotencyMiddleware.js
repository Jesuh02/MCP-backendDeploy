import crypto from 'crypto';

/**
 * Middleware de idempotencia para prevenir requests POST duplicados.
 * Genera un hash basado en method + path + body + userId y rechaza
 * requests idénticos dentro de una ventana temporal.
 *
 * Para requests sin token de autenticación, usa un hash simplificado
 * (method + path + IP) para agrupar y deduplicar todas las solicitudes
 * no autenticadas al mismo endpoint, evitando flood de errores 401.
 */
const recentRequests = new Map();
const unauthThrottle = new Map();
const DEDUP_WINDOW_MS = 10000; // 10 segundos
const UNAUTH_THROTTLE_MS = 5000; // 5 segundos de cooldown para requests sin auth
const CLEANUP_INTERVAL_MS = 30000;

// Limpieza periódica de entries expirados
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of recentRequests) {
        if (now - entry.timestamp > DEDUP_WINDOW_MS * 2) {
            recentRequests.delete(key);
        }
    }
    for (const [key, entry] of unauthThrottle) {
        if (now - entry.timestamp > UNAUTH_THROTTLE_MS * 2) {
            unauthThrottle.delete(key);
        }
    }
}, CLEANUP_INTERVAL_MS).unref();

function buildRequestHash(req) {
    const userId = req.user?.userId || req.body?.userId || 'anon';
    const bodyStr = JSON.stringify(req.body || {});
    const raw = `${req.method}:${req.path}:${userId}:${bodyStr}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Para requests sin Authorization, genera un hash simplificado
 * basado solo en method + path + IP para agrupar todas las solicitudes
 * no autenticadas al mismo endpoint desde la misma IP.
 */
function buildUnauthKey(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `unauth:${req.method}:${req.path}:${ip}`;
}

export function idempotencyGuard(req, res, next) {
    // Solo aplicar a métodos de escritura
    if (req.method !== 'POST') return next();

    // ── Throttle para requests sin token de autenticación ──
    // Agrupa TODOS los POST sin auth al mismo path+IP, sin importar el body,
    // para evitar flood de 401s por múltiples requests simultáneos.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const unauthKey = buildUnauthKey(req);
        const now = Date.now();
        const existing = unauthThrottle.get(unauthKey);

        if (existing && (now - existing.timestamp) < UNAUTH_THROTTLE_MS) {
            existing.count++;
            // Si ya tenemos la respuesta 401 cacheada, devolvemos esa
            if (existing.response) {
                return res.status(existing.statusCode || 401).json(existing.response);
            }
            // Si el primer request aún está en progreso, devolver 429
            return res.status(429).json({
                success: false,
                error: { code: 'TOO_MANY_UNAUTH_REQUESTS', message: 'Demasiadas solicitudes sin autenticación. Incluye un token válido.' },
            });
        }

        // Primera solicitud sin auth a este path+IP: dejar pasar pero registrar
        unauthThrottle.set(unauthKey, { timestamp: now, response: null, statusCode: null, count: 1 });

        // Interceptar la respuesta para cachearla
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            const entry = unauthThrottle.get(unauthKey);
            if (entry) {
                entry.response = body;
                entry.statusCode = res.statusCode;
            }
            return originalJson(body);
        };

        return next();
    }

    // ── Dedup normal para requests autenticados ──
    const hash = buildRequestHash(req);
    const now = Date.now();
    const existing = recentRequests.get(hash);
    if (existing && (now - existing.timestamp) < DEDUP_WINDOW_MS) {
        console.log(`[IdempotencyGuard] Duplicate request blocked: ${req.method} ${req.path}`);

        // Si ya tenemos la respuesta del request original, devolvemos esa
        if (existing.response) {
            return res.status(existing.statusCode || 200).json(existing.response);
        }

        // Si el request original aún está en progreso, retornamos 409
        return res.status(409).json({
            success: false,
            error: 'Solicitud duplicada detectada. Por favor espera unos segundos antes de reintentar.',
            code: 'DUPLICATE_REQUEST'
        });
    }

    // Registrar este request como en progreso
    recentRequests.set(hash, { timestamp: now, response: null, statusCode: null });
    // Interceptar la respuesta para cachearla
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const entry = recentRequests.get(hash);
        if (entry) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                // Solo cachear respuestas exitosas — las respuestas de error (401, 403, 5xx)
                // no se deben cachear para permitir reintentos con token refrescado.
                entry.response = body;
                entry.statusCode = res.statusCode;
            } else {
                // Eliminar la entrada para que el reintento (con token refrescado) pase normalmente
                recentRequests.delete(hash);
            }
        }
        return originalJson(body);
    };

    next();
}