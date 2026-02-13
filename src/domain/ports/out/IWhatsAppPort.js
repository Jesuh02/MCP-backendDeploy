/**
 * IWhatsAppPort — Puerto de salida para envío de mensajes vía WhatsApp.
 *
 * Define el contrato que cualquier adaptador de mensajería WhatsApp
 * debe implementar (Meta Cloud API, Twilio, etc.).
 *
 * @interface
 */
export class IWhatsAppPort {
    /**
     * Envía un mensaje de texto plano.
     * @param {string} phoneNumber — Número destino (formato E.164).
     * @param {string} text — Contenido del mensaje.
     * @returns {Promise<{messageId: string}>}
     */
    async sendTextMessage(phoneNumber, text) {
        throw new Error('Not implemented');
    }

    /**
     * Envía un mensaje interactivo con botones.
     * @param {string} phoneNumber
     * @param {object} options — { body, buttons: [{id, title}], header?, footer? }
     * @returns {Promise<{messageId: string}>}
     */
    async sendInteractiveMessage(phoneNumber, options) {
        throw new Error('Not implemented');
    }

    /**
     * Marca un mensaje como leído.
     * @param {string} waMessageId — ID del mensaje de WhatsApp.
     * @returns {Promise<void>}
     */
    async markAsRead(waMessageId) {
        throw new Error('Not implemented');
    }

    /**
     * Verifica si el servicio de WhatsApp está disponible.
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        throw new Error('Not implemented');
    }

    /**
     * Verifica la firma HMAC de un payload del webhook.
     * @param {string} payload — Body raw del request.
     * @param {string} signature — Valor del header X-Hub-Signature-256.
     * @returns {boolean}
     */
    verifySignature(payload, signature) {
        throw new Error('Not implemented');
    }
}

export default IWhatsAppPort;