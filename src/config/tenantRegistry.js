/**
 * TenantRegistry — Central registry of per-tenant Supabase clients.
 *
 * Uses AsyncLocalStorage for request-scoped tenant isolation and a Proxy
 * pattern so existing repositories route to the correct database transparently.
 *
 * OCP: add a tenant by setting TENANT_<ID>_SUPABASE_URL + _SERVICE_KEY env vars.
 * SRP: only manages tenant DB connections.
 * SRP: auto-heals SUPABASE_URL misconfiguration by deriving the URL from the JWT.
 */
import { createClient } from '@supabase/supabase-js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const tenantContext = new AsyncLocalStorage();

/** @type {Map<string, import('@supabase/supabase-js').SupabaseClient>} */
const tenantClients = new Map();

/** Default (primary) Supabase client — updated during initialization if URL was wrong. */
let defaultClient = null;
/** Public registry: tenant metadata (no secrets). */
export const TENANT_CONFIGS = [];

/**
 * Maps each Supabase project ref to its logical tenant identity.
 * Add a new entry here when onboarding a new institution.
 */
const PROJECT_REF_MAP = {
    'vxuksizvwrkctrvpciyp': { id: 'qa-develop', name: 'QA - Develop' },
    'gzckzrocfmhsizlrnqep': { id: 'incat', name: 'Politécnico Institucional del Caribe Incat' },
};

/**
 * Decodes a Supabase JWT and extracts the project ref (e.g. "vxuksizvwrkctrvpciyp").
 * The `ref` claim is the canonical identifier for the project.
 */
function extractProjectRef(jwtKey) {
    if (!jwtKey) return null;
    try {
        const [, payload] = jwtKey.split('.');
        if (!payload) return null;
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return decoded.ref || null;
    } catch {
        return null;
    }
}

/** Builds a Supabase REST URL from a project ref. */
function buildSupabaseUrl(ref) {
    return ref ? `https://${ref}.supabase.co` : null;
}

/**
 * Must be called once after SupabaseService is created.
 * Registers the primary tenant and any additional tenants from env vars.
 *
 * Auto-heals a misconfigured SUPABASE_URL by deriving the correct URL
 * from the service key's JWT `ref` claim — preventing cross-project key mismatches.
 */
export function initializeTenantRegistry(primaryClientFromProvider) {
    // ── Derive the authoritative project ref from the service key JWT ──
    const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    const configuredUrl = process.env.SUPABASE_URL || '';
    const derivedRef = extractProjectRef(serviceKey);
    const derivedUrl = buildSupabaseUrl(derivedRef);

    // If configured URL doesn't match the key's project, recreate the client with the correct URL.
    // This auto-heals a common misconfiguration where SUPABASE_URL was not updated after changing keys.
    let primaryClient = primaryClientFromProvider;
    let effectiveUrl = configuredUrl;

    if (derivedUrl && derivedUrl !== configuredUrl && serviceKey) {
        console.warn(
            `[TenantRegistry] ⚠️  SUPABASE_URL mismatch detected.` +
            ` Configured: ${configuredUrl || '(empty)'}, derived from key: ${derivedUrl}.` +
            ` Using derived URL to ensure correct database connection.`,
        );
        primaryClient = createClient(derivedUrl, serviceKey, {
            auth: { autoRefreshToken: true, persistSession: false },
        });
        effectiveUrl = derivedUrl;
    }

    defaultClient = primaryClient;

    // ── Register primary tenant ──
    if (effectiveUrl || derivedRef) {
        const tenantMeta = (derivedRef && PROJECT_REF_MAP[derivedRef]) || {
            id: process.env.TENANT_PRIMARY_ID || 'qa-develop',
            name: process.env.TENANT_PRIMARY_NAME || 'QA - Develop',
        };

        if (!tenantClients.has(tenantMeta.id)) {
            TENANT_CONFIGS.push({ ...tenantMeta, supabaseUrl: effectiveUrl });
            tenantClients.set(tenantMeta.id, primaryClient);
            console.log(`  ✅ Primary tenant registered: ${tenantMeta.id} → ${effectiveUrl}`);
        }
    }

    // ── Auto-discover additional tenants from TENANT_<ID>_SUPABASE_URL env vars ──
    const tenantEnvPattern = /^TENANT_([A-Z0-9_]+)_SUPABASE_URL$/;
    for (const [envKey, url] of Object.entries(process.env)) {
        const match = tenantEnvPattern.exec(envKey);
        if (!match || !url) continue;

        const envSuffix = match[1]; // e.g. 'INCAT'
        const tenantServiceKey = process.env[`TENANT_${envSuffix}_SUPABASE_SERVICE_KEY`];
        if (!tenantServiceKey) {
            console.warn(`  ⚠️  Tenant env TENANT_${envSuffix}: missing TENANT_${envSuffix}_SUPABASE_SERVICE_KEY`);
            continue;
        }

        const ref = extractProjectRef(tenantServiceKey);
        const tenantMeta = (ref && PROJECT_REF_MAP[ref]) || {
            id: envSuffix.toLowerCase(),
            name: envSuffix.charAt(0) + envSuffix.slice(1).toLowerCase(),
        };

        // Skip if this project is already registered (detected as primary or duplicate)
        if (tenantClients.has(tenantMeta.id)) continue;

        const client = createClient(url, tenantServiceKey, {
            auth: { autoRefreshToken: true, persistSession: false },
        });

        TENANT_CONFIGS.push({ id: tenantMeta.id, name: tenantMeta.name, supabaseUrl: url });
        tenantClients.set(tenantMeta.id, client);
        console.log(`  ✅ Tenant registered: ${tenantMeta.id} → ${url}`);
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

/**
 * Runs `fn` inside a specific tenant's AsyncLocalStorage context.
 * All tenant-aware repositories invoked inside `fn` will route to `tenantId`.
 *
 * SRP: encapsulates the boilerplate of running code in a tenant context.
 *
 * @param {string} tenantId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runInTenantContext(tenantId, fn) {
    const client = getTenantClient(tenantId);
    return new Promise((resolve, reject) => {
        tenantContext.run({ tenantId, client }, () => {
            Promise.resolve().then(fn).then(resolve).catch(reject);
        });
    });
}

/** Returns the currently active tenantId from AsyncLocalStorage (or null). */
export function getCurrentTenantId() {
    const store = tenantContext.getStore();
    return store ? store.tenantId : null;
}