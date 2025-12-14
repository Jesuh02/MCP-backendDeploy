/**
 * User Service
 * Servicio centralizado para operaciones de usuario
 * @module services/UserService
 */

import { SupabaseService } from '../infrastructure/database/SupabaseService.js';
import { logger } from '../infrastructure/logging/Logger.js';

class UserService {
    constructor() {
        this.supabase = SupabaseService.getInstance();
    }

    /**
     * Obtiene los datos de un usuario por ID
     * @param {number} userId - ID del usuario
     * @param {string[]} fields - Campos a seleccionar (default: email, username)
     * @returns {Promise<{data: object|null, error: object|null}>}
     */
    async getUserById(userId, fields = ['email', 'username']) {
        try {
            const userIdNumber = parseInt(userId, 10);
            if (isNaN(userIdNumber)) {
                return { data: null, error: { message: 'userId inválido' } };
            }

            const { data, error } = await this.supabase.client
                .from('usuarios')
                .select(fields.join(', '))
                .eq('id', userIdNumber)
                .single();

            return { data, error };
        } catch (error) {
            logger.error(`Error obteniendo usuario ${userId}:`, error);
            return { data: null, error };
        }
    }

    /**
     * Obtiene el email de un usuario por ID
     * @param {number} userId - ID del usuario
     * @returns {Promise<string|null>} Email del usuario o null
     */
    async getUserEmail(userId) {
        const { data, error } = await this.getUserById(userId, ['email']);
        
        if (error || !data || !data.email) {
            return null;
        }

        return data.email;
    }

    /**
     * Obtiene el username de un usuario por ID
     * @param {number} userId - ID del usuario
     * @returns {Promise<string|null>} Username del usuario o null
     */
    async getUsername(userId) {
        const { data, error } = await this.getUserById(userId, ['username']);
        
        if (error || !data || !data.username) {
            return null;
        }

        return data.username;
    }

    /**
     * Valida si un email es válido y usable para envío
     * @param {string} email - Email a validar
     * @returns {{valid: boolean, reason: string|null}}
     */
    validateEmail(email) {
        if (!email) {
            return { valid: false, reason: 'Email vacío o nulo' };
        }

        if (email === '.') {
            return { valid: false, reason: 'Email placeholder "." (no configurado)' };
        }

        if (email.startsWith('missing_email_')) {
            return { valid: false, reason: `Email placeholder temporal: ${email}` };
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return { valid: false, reason: `Formato de email inválido: ${email}` };
        }

        return { valid: true, reason: null };
    }

    /**
     * Obtiene email validado de un usuario
     * @param {number} userId - ID del usuario
     * @returns {Promise<{email: string|null, username: string|null, valid: boolean, reason: string|null}>}
     */
    async getValidatedUserEmail(userId) {
        const { data, error } = await this.getUserById(userId, ['email', 'username']);

        if (error) {
            return {
                email: null,
                username: null,
                valid: false,
                reason: `DB error: ${error.message || JSON.stringify(error)}`
            };
        }

        if (!data) {
            return {
                email: null,
                username: null,
                valid: false,
                reason: 'Usuario no encontrado en base de datos'
            };
        }

        const validation = this.validateEmail(data.email);

        return {
            email: validation.valid ? data.email : null,
            username: data.username || 'Usuario',
            valid: validation.valid,
            reason: validation.reason
        };
    }

    /**
     * Obtiene los tokens FCM de un usuario
     * @param {number} userId - ID del usuario
     * @returns {Promise<string[]>} Array de tokens FCM
     */
    async getUserFCMTokens(userId) {
        try {
            const { data: tokens, error } = await this.supabase.client
                .from('user_fcm_tokens')
                .select('token')
                .eq('user_id', userId);

            if (error || !tokens || tokens.length === 0) {
                return [];
            }

            // Eliminar duplicados
            const uniqueTokens = [...new Set(tokens.map(t => t.token))];
            return uniqueTokens;
        } catch (error) {
            logger.error(`Error obteniendo tokens FCM para usuario ${userId}:`, error);
            return [];
        }
    }

    /**
     * Elimina tokens FCM inválidos
     * @param {string[]} tokens - Array de tokens a eliminar
     * @returns {Promise<boolean>} true si se eliminaron correctamente
     */
    async removeInvalidFCMTokens(tokens) {
        if (!tokens || tokens.length === 0) return true;

        try {
            await this.supabase.client
                .from('user_fcm_tokens')
                .delete()
                .in('token', tokens);
            
            logger.info(`🧹 Eliminados ${tokens.length} tokens FCM inválidos`);
            return true;
        } catch (error) {
            logger.error('Error eliminando tokens FCM inválidos:', error);
            return false;
        }
    }

    /**
     * Obtiene suscriptores de un creador
     * @param {number} creatorId - ID del creador
     * @returns {Promise<number[]>} Array de IDs de suscriptores
     */
    async getSubscriberIds(creatorId) {
        try {
            const { data, error } = await this.supabase.client
                .from('subscriptions')
                .select('subscriber_id')
                .eq('creator_id', creatorId);

            if (error || !data) {
                return [];
            }

            return data.map(s => s.subscriber_id);
        } catch (error) {
            logger.error(`Error obteniendo suscriptores del creador ${creatorId}:`, error);
            return [];
        }
    }

    /**
     * Obtiene múltiples usuarios por IDs
     * @param {number[]} userIds - Array de IDs de usuarios
     * @param {string[]} fields - Campos a seleccionar
     * @returns {Promise<object[]>} Array de usuarios
     */
    async getUsersByIds(userIds, fields = ['id', 'username', 'email']) {
        if (!userIds || userIds.length === 0) return [];

        try {
            const { data, error } = await this.supabase.client
                .from('usuarios')
                .select(fields.join(', '))
                .in('id', userIds);

            if (error || !data) {
                return [];
            }

            return data;
        } catch (error) {
            logger.error('Error obteniendo múltiples usuarios:', error);
            return [];
        }
    }
}

// Singleton instance
let instance = null;

export function getUserService() {
    if (!instance) {
        instance = new UserService();
    }
    return instance;
}

export { UserService };
export default UserService;
