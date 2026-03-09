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
        const sessions = await this.findAllByUserId(userId);
        return sessions[0] || null;
    }

    async findAllByUserId(userId) {
        const { data, error } = await this.client
            .from(this.table)
            .select('*')
            .eq('user_id', userId)
            .order('is_active', { ascending: false })
            .order('created_at', { ascending: false })
;

        if (error) {
            console.error('[WhatsAppSessionRepo] findAllByUserId error:', error.message);
            return [];
        }
        return Array.isArray(data) ? data.map((row) => WhatsAppSession.fromSupabaseRow(row)) : [];
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
     * Intenta primero la función RPC SECURITY DEFINER (garantiza escritura
     * incluso con restricciones RLS). Si el RPC falla, cae al cliente JS.
     * @param {number} userId
     * @returns {Promise<void>}
     * @throws {Error} si ninguna estrategia pudo desactivar la sesión.
     */
    async deactivate(userId) {
        const existingSessions = await this.findAllByUserId(userId);
        if (!existingSessions.length) {
            return;
        }

        // Estrategia 1: RPC SECURITY DEFINER (bypasses RLS)
        try {
            const { data: rpcCount, error: rpcError } = await this.client
                .rpc('deactivate_whatsapp_session_for_user', { p_user_id: Number(userId) });
            if (!rpcError) {
                const count = typeof rpcCount === 'number' ? rpcCount : 0;
                console.log(`[WhatsAppSessionRepo] deactivate (RPC) userId=${userId} updatedRows=${count}`);
                if (count === 0) {
                    throw new Error(`deactivate: 0 rows updated via RPC for userId=${userId}`);
                }
                return;
            }
            console.warn('[WhatsAppSessionRepo] deactivate RPC unavailable, falling back to JS client:', rpcError.message);
        } catch (rpcEx) {
            if (!rpcEx.message?.includes('0 rows updated')) {
                console.warn('[WhatsAppSessionRepo] deactivate RPC failed:', rpcEx.message);
            } else {
                throw rpcEx; // 0 rows — propagate
            }
        }

        // Estrategia 2: cliente JS con .select() para detectar 0 rows
        const { data, error } = await this.client
            .from(this.table)
            .update({
                is_active: false,
                wa_id: null,
                otp_code: null,
                otp_expires_at: null,
                conversation_context: [],
                last_message_at: null,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
            .select('id');

        if (error) {
            console.error('[WhatsAppSessionRepo] deactivate error:', error.message);
            throw new Error(`Error desactivando sesión de WhatsApp: ${error.message}`);
        }

        const updatedCount = Array.isArray(data) ? data.length : 0;
        console.log(`[WhatsAppSessionRepo] deactivate (JS) userId=${userId} updatedRows=${updatedCount}`);
        if (updatedCount === 0) {
            throw new Error(`deactivate: 0 rows updated for userId=${userId} — possible RLS/permission issue`);
        }
    }

    /**
     * Elimina la sesión de un usuario (hard delete).
     * Intenta primero la función RPC SECURITY DEFINER (garantiza eliminación
     * incluso con restricciones RLS). Si el RPC no está disponible, usa el
     * cliente JS como fallback.
     * @param {number} userId
     * @returns {Promise<number>} número de filas eliminadas.
     * @throws {Error} si la operación falla en la base de datos.
     */
    async deleteByUserId(userId) {
        const existingSessions = await this.findAllByUserId(userId);
        if (!existingSessions.length) {
            return 0;
        }

        // Estrategia 1: RPC SECURITY DEFINER (bypasses RLS)
        try {
            const { data: rpcCount, error: rpcError } = await this.client
                .rpc('delete_whatsapp_session_for_user', { p_user_id: Number(userId) });
            if (!rpcError) {
                const count = typeof rpcCount === 'number' ? rpcCount : 0;
                console.log(`[WhatsAppSessionRepo] deleteByUserId (RPC) userId=${userId} deletedRows=${count}`);
                if (count > 0) {
                    return count;
                }
            }
            console.warn('[WhatsAppSessionRepo] deleteByUserId RPC unavailable, falling back to JS client:', rpcError.message);
        } catch (rpcEx) {
            console.warn('[WhatsAppSessionRepo] deleteByUserId RPC failed:', rpcEx.message);
        }

        // Estrategia 2: cliente JS con .select() para detectar filas afectadas
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
        console.log(`[WhatsAppSessionRepo] deleteByUserId (JS) userId=${userId} deletedRows=${deletedCount}`);
        if (deletedCount === 0 && existingSessions.length > 0) {
            throw new Error(`deleteByUserId: 0 rows deleted for userId=${userId} — possible RLS/permission issue`);
        }
        return deletedCount;
    }
}

export default SupabaseWhatsAppSessionRepository;

