/**
 * SupabaseWhatsAppSessionRepository — Implementación de IWhatsAppSessionRepository.
 *
 * Persiste sesiones de WhatsApp en la tabla whatsapp_sessions de Supabase.
 *
 * Principios:
 *   - SRP: solo gestiona la persistencia de sesiones WhatsApp.
 *   - DIP: el dominio depende del puerto IWhatsAppSessionRepository,
 *     no de esta implementación concreta.
 */
import { WhatsAppSession } from '../../../domain/entities/WhatsAppSession.js';

export class SupabaseWhatsAppSessionRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} client
     */
    constructor(client) {
        this.client = client;
        this.table = 'whatsapp_sessions';
    }

    /**
     * Busca una sesión por número de teléfono.
     * @param {string} phoneNumber — Formato E.164.
     * @returns {Promise<WhatsAppSession|null>}
     */
    async findByPhoneNumber(phoneNumber) {
        // Try multiple normalized variants to be resilient to incoming formats
        const variants = new Set();
        if (!phoneNumber) return null;
        const raw = String(phoneNumber).trim();
        variants.add(raw);
        // Ensure leading +
        if (!raw.startsWith('+')) variants.add('+' + raw);
        // Also try without +
        if (raw.startsWith('+')) variants.add(raw.replace(/^[+]/, ''));
        // Try default country code variant if configured; infer one from
        // the provider phone number when the explicit env var is missing.
        const defaultCC = (() => {
            if (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE) {
                return process.env.WHATSAPP_DEFAULT_COUNTRY_CODE.replace(/[^0-9]/g, '');
            }
            const candidates = [
                process.env.YCLOUD_WHATSAPP_NUMBER,
                process.env.WHATSAPP_PHONE_NUMBER,
                process.env.WHATSAPP_NUMBER,
                process.env.YCLOUD_PHONE,
            ];
            for (const cand of candidates) {
                if (cand) {
                    const digits = String(cand).replace(/\D+/g, '');
                    if (digits.length > 10) {
                        return digits.slice(0, digits.length - 10);
                    }
                }
            }
            return '';
        })();
        if (defaultCC) {
            let digits = raw.replace(/^\+/, '');
            if (!digits.startsWith(defaultCC)) {
                variants.add(`+${defaultCC}${digits}`);
            }
        }

        // Try exact matches in order
        for (const p of variants) {
            try {
                const { data, error } = await this.client
                    .from(this.table)
                    .select('*')
                    .eq('phone_number', p)
                    .maybeSingle();

                if (error) {
                    console.error('[WhatsAppSessionRepo] findByPhoneNumber error for', p, error.message);
                    continue;
                }

                if (data) return WhatsAppSession.fromSupabaseRow(data);
            } catch (e) {
                console.error('[WhatsAppSessionRepo] findByPhoneNumber unexpected error for', p, e && e.message);
                continue;
            }
        }

        // Fallback: try loose match by stripping non-digits
        try {
            const digits = raw.replace(/\D+/g, '');
            if (digits) {
                const { data, error } = await this.client
                    .from(this.table)
                    .select('*')
                    .ilike('phone_number', `%${digits}`)
                    .limit(1)
                    .maybeSingle();

                if (!error && data) return WhatsAppSession.fromSupabaseRow(data);
            }
        } catch (e) {
            console.error('[WhatsAppSessionRepo] loose findByPhoneNumber failed:', e && e.message);
        }

        return null;
    }

    /**
     * Busca una sesión por ID de usuario.
     * @param {number} userId
     * @returns {Promise<WhatsAppSession|null>}
     */
    async findByUserId(userId) {
        // Use limit(1) + order so that duplicate rows (e.g. from missing UNIQUE
        // constraint) never cause .maybeSingle() to throw PGRST116.
        // Prefer the active session; fall back to the most recent one.
        const { data, error } = await this.client
            .from(this.table)
            .select('*')
            .eq('user_id', userId)
            .order('is_active', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('[WhatsAppSessionRepo] findByUserId error:', error.message);
            return null;
        }
        return data ? WhatsAppSession.fromSupabaseRow(data) : null;
    }

    /**
     * Crea una nueva sesión.
     * @param {object} sessionData — Campos en formato snake_case.
     * @returns {Promise<WhatsAppSession>}
     */
    async save(sessionData) {
        const { data, error } = await this.client
            .from(this.table)
            .upsert(sessionData, { onConflict: 'user_id' })
            .select('*')
            .single();

        if (error) {
            console.error('[WhatsAppSessionRepo] save error:', error.message);
            throw new Error(`Error saving WhatsApp session: ${error.message}`);
        }
        return WhatsAppSession.fromSupabaseRow(data);
    }

    /**
     * Actualiza campos de una sesión existente.
     * @param {number} sessionId
     * @param {object} updates — Campos a actualizar (snake_case).
     * @returns {Promise<WhatsAppSession|null>}
     */
    async update(sessionId, updates) {
        const { data, error } = await this.client
            .from(this.table)
            .update({...updates, updated_at: new Date().toISOString() })
            .eq('id', sessionId)
            .select('*')
            .single();

        if (error) {
            console.error('[WhatsAppSessionRepo] update error:', error.message);
            return null;
        }
        return data ? WhatsAppSession.fromSupabaseRow(data) : null;
    }

    /**
     * Desactiva la sesión de un usuario (soft delete).
     * @param {number} userId
     * @returns {Promise<void>}
     * @throws {Error} si la operación falla en la base de datos.
     */
    async deactivate(userId) {
        const { error } = await this.client
            .from(this.table)
            .update({
                is_active: false,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId);

        if (error) {
            console.error('[WhatsAppSessionRepo] deactivate error:', error.message);
            throw new Error(`Error desactivando sesión de WhatsApp: ${error.message}`);
        }
    }

    /**
     * Elimina la sesión de un usuario (hard delete).
     * @param {number} userId
     * @returns {Promise<void>}
     * @throws {Error} si la operación falla en la base de datos.
     */
    async deleteByUserId(userId) {
        const { data, error } = await this.client
            .from(this.table)
            .delete()
            .eq('user_id', userId)
            .select('id');

        if (error) {
            console.error('[WhatsAppSessionRepo] deleteByUserId error:', error.message);
            throw new Error(`Error eliminando sesión de WhatsApp: ${error.message}`);
        }

        const deletedCount = Array.isArray(data) ? data.length : 0;
        console.log(`[WhatsAppSessionRepo] deleteByUserId userId=${userId} deletedRows=${deletedCount}`);
        return deletedCount;
    }
}

export default SupabaseWhatsAppSessionRepository;

