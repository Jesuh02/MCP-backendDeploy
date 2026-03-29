/**
 * TenantMiddleware — Sets per-request tenant context from the JWT.
 *
 * Runs early in the middleware chain. Extracts tenantId from:
 *   1. Authorization Bearer token (access JWT)
 *   2. Refresh token in the request body
 *   3. Falls back to 'qa-develop'
 *
 * The resolved tenantId is stored in AsyncLocalStorage so the
 * tenant-aware Supabase Proxy routes DB queries transparently.
 */
import { tenantContext, getTenantClient } from '../../config/tenantRegistry.js';

export function createTenantMiddleware(jwtAdapter) {
    return (req, _res, next) => {
        let tenantId = 'qa-develop';

        // Try Bearer token first (most common: authenticated requests)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const { valid, decoded } = jwtAdapter.verifyAccessToken(authHeader.slice(7));
                if (valid && decoded && decoded.tenantId) tenantId = decoded.tenantId;
            } catch { /* use default */ }
        }
        // Fallback: refresh-token requests carry tenantId inside the refresh JWT
        else if (req.body && req.body.refreshToken) {
            try {
                const { valid, decoded } = jwtAdapter.verifyRefreshToken(req.body.refreshToken);
                if (valid && decoded && decoded.tenantId) tenantId = decoded.tenantId;
            } catch { /* use default */ }
        }
        const client = getTenantClient(tenantId);
        tenantContext.run({ tenantId, client }, () => next());
    };
}
