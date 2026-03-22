/**
 * IEmailPort — Interfaz para adaptadores de envío de email.
 *
 * Define el contrato que deben implementar Resend, SendGrid, SMTP, etc.
 */
export class IEmailPort {
    /**
     * Indica si el adaptador está disponible.
     * @returns {boolean}
     */
    isAvailable() {
        throw new Error('IEmailPort.isAvailable() not implemented');
    }

    /**
     * Envía un email.
     * @param {object} options
     * @param {string} options.to — Destinatario.
     * @param {string} options.subject — Asunto.
     * @param {string} options.html — Cuerpo HTML.
     * @param {string} [options.text] — Cuerpo texto plano (fallback).
     * @returns {Promise<{success: boolean, messageId?: string}>}
     */
    async sendEmail({ to, subject, html, text }) {
        throw new Error('IEmailPort.sendEmail() not implemented');
    }
}
export default IEmailPort;
