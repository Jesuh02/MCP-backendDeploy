/**
 * IEmailPort — Puerto de salida para envío de emails.
 * @interface
 */
export class IEmailPort {
    async sendEmail(to, subject, htmlContent) { throw new Error('Not implemented'); }
    isAvailable() { throw new Error('Not implemented'); }
}
export default IEmailPort;