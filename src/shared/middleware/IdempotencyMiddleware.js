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

// Paths where each identical POST intentionally produces a different effect
// (e.g. toggle endpoints). They must NOT be deduplicated.
const EXCLUDED_PATHS = ['/likes/toggle'];

// High-frequency streaming endpoints where identical request bodies are
// expected and intentional (e.g. sign-language frame capture: consecutive
// frames of a still hand are byte-for-byte identical by design, yet each
// POST must reach the classifier so letters and vowels are detected).
// Deduplication here is catastrophic: it silently blocks all but the first
// frame for 10 seconds, preventing any letter/vowel detection.
const STREAMING_PATHS = ['/sign-language/session/'];

// Long-running endpoints (AI generation) whose duration far exceeds the default
// 10s dedup window. Excluded because:
//   1. The frontend already serializes calls with its own in-flight flag.
//   2. A duplicate within 10s would be wrongly 409'd while the original is still
//      running (response not yet cached), breaking legitimate retries after
//      navigation/remount.
//   3. After 10s the entry expires and a duplicate would WRONGLY start a second
//      expensive generation — opposite of what dedup is supposed to do.
// For these endpoints, idempotency must be enforced at the application layer
// (e.g. job table keyed by userId+topicId+taskId), not in this middleware.
const LONG_RUNNING_PATHS = [
    '/learning/comic',
    '/learning/video',
    '/learning/comic/regenerate-panel',
];

// MCP protocol paths are exempt from both dedup and unauth-throttle.
// The MCP JSON-RPC protocol sends rapid sequential POSTs (initialize,
// tools/list, resources/list, tools/call) without Bearer tokens — blocking
// them breaks the MCP handshake. Each message is inherently unique
// (different JSON-RPC id + method) so dedup adds no value here.
const MCP_PATHS = ['/mcp/message', '/mcp/initialize', '/tools/call', '/tools/list', '/resources/list'];

export function idempotencyGuard(req, res, next) {
    // Solo aplicar a métodos de escritura
    if (req.method !== 'POST') return next();

    // Skip idempotency for intentional toggle endpoints
    if (EXCLUDED_PATHS.some(p => req.path.endsWith(p))) return next();

    // Skip idempotency for high-frequency sign-language streaming endpoints.
    // Consecutive frames of a still hand are intentionally identical; dedup
    // would block letter/vowel detection for 10 s at a time.
    if (STREAMING_PATHS.some(p => req.path.includes(p))) return next();

    // Skip idempotency for long-running AI generation endpoints.
    // See LONG_RUNNING_PATHS comment above for rationale.
    if (LONG_RUNNING_PATHS.some(p => req.path.endsWith(p))) return next();

    // Skip idempotency entirely for MCP protocol endpoints.
    // MCP sends rapid sequential unauthenticated POSTs during handshake.
    if (MCP_PATHS.some(p => req.path.endsWith(p) || req.path.includes('/mcp/'))) return next();

    // ── Throttle para requests sin token de autenticación ──
    // Agrupa TODOS los POST sin auth al mismo path+IP, sin importar el body,
    // para evitar flood de 401s por múltiples requests simultáneos.
    const authHeader = req.headers.authorization;
    const hasCookieAuth = !!(req.cookies && req.cookies.access_token);
    if (!hasCookieAuth && (!authHeader || !authHeader.startsWith('Bearer '))) {
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
            error: {
                code: 'DUPLICATE_REQUEST',
                message: 'Solicitud duplicada detectada. Por favor espera unos segundos antes de reintentar.',
                statusCode: 409,
            },
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