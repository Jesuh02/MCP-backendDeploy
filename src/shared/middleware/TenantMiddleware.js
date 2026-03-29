/**
 * TenantMiddleware — Sets per-request tenant context from the JWT.
 *
 * Runs early in the middleware chain. Extracts tenantId from:
 *   1. Authorization Bearer token (access JWT)  — contains tenantId + availableTenants
 *   2. X-Tenant-Id header override (chat views that let users switch institutions)
 *      Only honoured when the requested tenantId is listed in the JWT's availableTenants.
 *   3. Refresh token in the request body
 *   4. Falls back to 'qa-develop'
 *
 * The resolved tenantId is stored in AsyncLocalStorage so the
 * tenant-aware Supabase Proxy routes DB queries transparently.
 */
import { tenantContext, getTenantClient } from '../../config/tenantRegistry.js';

export function createTenantMiddleware(jwtAdapter) {
    return (req, _res, next) => {
        let tenantId = 'qa-develop';
        let availableTenants = null;

        // Try Bearer token first (most common: authenticated requests)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const { valid, decoded } = jwtAdapter.verifyAccessToken(authHeader.slice(7));
                if (valid && decoded) {
                    if (decoded.tenantId) tenantId = decoded.tenantId;
                    if (Array.isArray(decoded.availableTenants)) availableTenants = decoded.availableTenants;
                }
            } catch { /* use default */ }
        }
        // Fallback: refresh-token requests carry tenantId inside the refresh JWT
        else if (req.body && req.body.refreshToken) {
            try {
                const { valid, decoded } = jwtAdapter.verifyRefreshToken(req.body.refreshToken);
                if (valid && decoded) {
                    if (decoded.tenantId) tenantId = decoded.tenantId;
                    if (Array.isArray(decoded.availableTenants)) availableTenants = decoded.availableTenants;
                }
            } catch { /* use default */ }
        }

        // X-Tenant-Id override: allows chat views to switch the query institution
        // within the same authenticated session.  Only accepted when the user's JWT
        // explicitly lists that tenant in availableTenants — prevents privilege
        // escalation to tenants the user doesn't belong to.
        const requestedTenant = req.headers['x-tenant-id'];
        if (requestedTenant && availableTenants && availableTenants.includes(requestedTenant)) {
            tenantId = requestedTenant;
        }

        const client = getTenantClient(tenantId);
        tenantContext.run({ tenantId, client }, () => next());
    };
}
