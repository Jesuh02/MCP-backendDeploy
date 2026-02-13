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
        const { data, error } = await this.client
            .from(this.table)
            .select('*')
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        if (error) {
            console.error('[WhatsAppSessionRepo] findByPhoneNumber error:', error.message);
            return null;
        }
        return data ? WhatsAppSession.fromSupabaseRow(data) : null;
    }

    /**
     * Busca una sesión por ID de usuario.
     * @param {number} userId
     * @returns {Promise<WhatsAppSession|null>}
     */
    async findByUserId(userId) {
        const { data, error } = await this.client
            .from(this.table)
            .select('*')
            .eq('user_id', userId)
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
        }
    }

    /**
     * Elimina la sesión de un usuario (hard delete).
     * @param {number} userId
     * @returns {Promise<void>}
     */
    async deleteByUserId(userId) {
        const { error } = await this.client
            .from(this.table)
            .delete()
            .eq('user_id', userId);

        if (error) {
            console.error('[WhatsAppSessionRepo] deleteByUserId error:', error.message);
        }
    }
}

export default SupabaseWhatsAppSessionRepository;