/**
 * CrossTenantWhatsAppSessionRepository
 *
 * Searches WhatsApp sessions across ALL registered tenant databases.
 * Used by the webhook handler, which receives no JWT and therefore cannot rely
 * on the per-request TenantMiddleware to set the correct Supabase client.
 *
 * Principles:
 *   SRP  – Only responsible for cross-tenant session discovery.
 *   DIP  – Depends on tenantRegistry abstractions, not concrete Supabase imports.
 *   OCP  – New tenants are discovered automatically from the registry.
 */
import { getAllTenantEntries } from '../../../config/tenantRegistry.js';
import { SupabaseWhatsAppSessionRepository } from './supabase.whatsapp-session.repository.js';

/**
 * @typedef {{ session: import('../whatsapp-session.entity.js').WhatsAppSession, tenantId: string, client: import('@supabase/supabase-js').SupabaseClient }} TenantSessionMatch
 */

export class CrossTenantWhatsAppSessionRepository {
    /**
     * Searches every registered tenant's `whatsapp_sessions` table for the given
     * phone number in parallel.
     *
     * @param {string} phoneNumber – E.164 format.
     * @returns {Promise<TenantSessionMatch[]>} All matching sessions across all tenants.
     */
    async findAllByPhoneNumber(phoneNumber) {
        const entries = getAllTenantEntries();
        if (!entries.length) return [];

        const results = await Promise.allSettled(
            entries.map(entry => this._probeTenant(entry, phoneNumber)),
        );

        /** @type {TenantSessionMatch[]} */
        const matches = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                matches.push(r.value);
            }
        }
        return matches;
    }

    /**
     * Convenience method: returns the first active session found across all tenants,
     * along with its tenantId and Supabase client.
     *
     * If the phone appears in multiple tenants, returns all of them so the caller
     * can ask the user which institution they want to query.
     *
     * @param {string} phoneNumber
     * @returns {Promise<TenantSessionMatch | TenantSessionMatch[] | null>}
     *   - null            → no session found in any tenant
     *   - TenantSessionMatch  → exactly one match (the client's session tenant)
     *   - TenantSessionMatch[] → user exists in multiple tenants (needs selection)
     */
    async findByPhoneNumber(phoneNumber) {
            const matches = await this.findAllByPhoneNumber(phoneNumber);
            // Filter to active-only sessions; prefer active over inactive
            const active = matches.filter(m => m.session.isActive);
        const pool = active.length ? active : matches;

        if (!pool.length) return null;
        if (pool.length === 1) return pool[0];
        return pool; // caller must handle multi-tenant selection
    }

    // ──────────────────────────────────────────────────────────
    // Private helpers
    // ──────────────────────────────────────────────────────────

    /**
     * @param {{ id: string, client: import('@supabase/supabase-js').SupabaseClient }} entry
     * @param {string} phoneNumber
     * @returns {Promise<TenantSessionMatch | null>}
     */
    async _probeTenant(entry, phoneNumber) {
        if (!entry.client) return null;
        try {
            const repo = new SupabaseWhatsAppSessionRepository(entry.client);
            const session = await repo.findByPhoneNumber(phoneNumber);
            if (!session) return null;
            // Enrich session entity with the discovered tenantId
            session.tenantId = entry.id;
            return { session, tenantId: entry.id, client: entry.client };
        } catch (err) {
            console.warn(
                `[CrossTenantWASessionRepo] probe failed for tenant=${entry.id}: ${err?.message}`,
            );
            return null;
        }
    }
}
