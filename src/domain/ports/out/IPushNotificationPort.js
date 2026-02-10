/**
 * IPushNotificationPort — Puerto de salida para notificaciones push (FCM).
 * @interface
 */
export class IPushNotificationPort {
    async sendToTokens(tokens, title, body, data) { throw new Error('Not implemented'); }
    isAvailable() { throw new Error('Not implemented'); }
}
export default IPushNotificationPort;