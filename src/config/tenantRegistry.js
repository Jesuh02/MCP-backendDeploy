/**
 * TenantRegistry — Central registry of per-tenant Supabase clients.
 *
 * Uses AsyncLocalStorage for request-scoped tenant isolation and a Proxy
 * pattern so existing repositories route to the correct database transparently.
 *
 * OCP: add a tenant by setting TENANT_<ID>_SUPABASE_URL + _SERVICE_KEY env vars.
 * SRP: only manages tenant DB connections.
 */
import { createClient } from '@supabase/supabase-js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const tenantContext = new AsyncLocalStorage();

/** @type {Map<string, import('@supabase/supabase-js').SupabaseClient>} */
const tenantClients = new Map();

/** Default (primary) Supabase client from SupabaseService. */
let defaultClient = null;
/** Public registry: tenant metadata (no secrets). */
export const TENANT_CONFIGS = [];

/**
 * Must be called once after SupabaseService is created.
 * Registers the primary tenant + any additional tenants from env vars.
 */
export function initializeTenantRegistry(primaryClient) {
    defaultClient = primaryClient;
    // ── Primary tenant (uses existing SUPABASE_* env vars) ──
    const primaryUrl = process.env.SUPABASE_URL;
    if (primaryUrl) {
        TENANT_CONFIGS.push({
            id: 'qa-develop',
            name: 'QA - Develop',
            supabaseUrl: primaryUrl,
        });
        tenantClients.set('qa-develop', primaryClient);
    }

    // ── INCAT tenant ──
    const incatUrl = process.env.TENANT_INCAT_SUPABASE_URL;
    const incatKey = process.env.TENANT_INCAT_SUPABASE_SERVICE_KEY;
    if (incatUrl && incatKey) {
        const client = createClient(incatUrl, incatKey, {
            auth: { autoRefreshToken: true, persistSession: false },
        });
        TENANT_CONFIGS.push({
            id: 'incat',
            name: 'Politécnico Institucional del Caribe Incat',
            supabaseUrl: incatUrl,
        });
        tenantClients.set('incat', client);
        console.log('  ✅ Tenant registered: incat');
    } else {
        console.warn('  ⚠️  INCAT tenant not configured (set TENANT_INCAT_SUPABASE_URL + TENANT_INCAT_SUPABASE_SERVICE_KEY)');
    }

    console.log(`[TenantRegistry] ${TENANT_CONFIGS.length} tenant(s) active: ${TENANT_CONFIGS.map(t => t.id).join(', ')}`);
}

/** Returns the Supabase client for a specific tenantId. Falls back to default. */
export function getTenantClient(tenantId) {
    return tenantClients.get(tenantId) || defaultClient;
}

/** Returns the client for the current request via AsyncLocalStorage. */
export function getCurrentTenantClient() {
    const store = tenantContext.getStore();
    if (store && store.tenantId) return tenantClients.get(store.tenantId) || defaultClient;
    return defaultClient;
}

/** Returns every tenant entry with its Supabase client (for cross-tenant search). */
export function getAllTenantEntries() {
    return TENANT_CONFIGS.map(config => ({
        ...config,
        client: tenantClients.get(config.id),
    }));
}

/**
 * Creates a Proxy over defaultClient that delegates every call to the
 * current request's tenant client (read from AsyncLocalStorage).
 * Repositories injected with this proxy query the correct DB automatically.
 */
export function createTenantAwareProxy(fallbackClient) {
    return new Proxy(fallbackClient, {
        get(target, prop) {
            const client = getCurrentTenantClient() || target;
            const value = client[prop];
            return typeof value === 'function' ? value.bind(client) : value;
        },
    });
}