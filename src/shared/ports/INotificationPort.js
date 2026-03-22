/**
 * INotificationPort — Interfaz para adaptadores de notificaciones push.
 *
 * Define el contrato que deben implementar FCM, OneSignal, APN, etc.
 */
export class INotificationPort {
    /**
     * Indica si el adaptador está disponible.
     * @returns {boolean}
     */
    isAvailable() {
        throw new Error('INotificationPort.isAvailable() not implemented');
    }

    /**
     * Envía notificación push a tokens específicos.
     * @param {string[]} tokens — FCM/APN tokens del dispositivo.
     * @param {string} title — Título de la notificación.
     * @param {string} body — Mensaje.
     * @param {object} [data] — Datos adicionales.
     * @returns {Promise<{successCount: number, failureCount: number, invalidTokens: string[]}>}
     */
    async sendToTokens(tokens, title, body, data) {
        throw new Error('INotificationPort.sendToTokens() not implemented');
    }
}
export default INotificationPort;