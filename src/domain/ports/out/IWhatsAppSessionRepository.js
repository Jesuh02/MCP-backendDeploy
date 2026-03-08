/**
 * IWhatsAppSessionRepository — Puerto de salida para persistencia de sesiones WhatsApp.
 *
 * Define el contrato de repositorio para gestionar las sesiones
 * de vinculación entre usuarios y números de WhatsApp.
 *
 * @interface
 */
export class IWhatsAppSessionRepository {
    /**
     * Busca una sesión por número de teléfono.
     * @param {string} phoneNumber
     * @returns {Promise<import('../../entities/WhatsAppSession.js').WhatsAppSession|null>}
     */
    async findByPhoneNumber(phoneNumber) {
        throw new Error('Not implemented');
    }

    /**
     * Busca una sesión por ID de usuario.
     * @param {number} userId
     * @returns {Promise<import('../../entities/WhatsAppSession.js').WhatsAppSession|null>}
     */
    async findByUserId(userId) {
        throw new Error('Not implemented');
    }

    /**
     * Lista todas las sesiones asociadas a un usuario.
     * @param {number} userId
     * @returns {Promise<import('../../entities/WhatsAppSession.js').WhatsAppSession[]>}
     */
    async findAllByUserId(userId) {
        throw new Error('Not implemented');
    }

    /**
     * Crea o actualiza una sesión.
     * @param {object} sessionData
     * @returns {Promise<import('../../entities/WhatsAppSession.js').WhatsAppSession>}
     */
    async save(sessionData) {
        throw new Error('Not implemented');
    }

    /**
     * Actualiza campos de una sesión existente.
     * @param {number} sessionId
     * @param {object} updates
     * @returns {Promise<import('../../entities/WhatsAppSession.js').WhatsAppSession|null>}
     */
    async update(sessionId, updates) {
        throw new Error('Not implemented');
    }

    /**
     * Desactiva la sesión de un usuario.
     * @param {number} userId
     * @returns {Promise<void>}
     */
    async deactivate(userId) {
        throw new Error('Not implemented');
    }

    /**
     * Elimina la sesión de un usuario.
     * @param {number} userId
     * @returns {Promise<void>}
     */
    async deleteByUserId(userId) {
        throw new Error('Not implemented');
    }
}
export default IWhatsAppSessionRepository;


