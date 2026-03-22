/**
 * IPaymentGatewayPort — Interfaz para adaptadores de pasarela de pago.
 *
 * Define el contrato que deben implementar Wompi, Stripe, MercadoPago, etc.
 */
export class IPaymentGatewayPort {
    /**
     * Indica si el adaptador está disponible.
     * @returns {boolean}
     */
    isAvailable() {
        throw new Error('IPaymentGatewayPort.isAvailable() not implemented');
    }

    /**
     * Crea un link/sesión de checkout.
     * @param {object} options
     * @param {number} options.amountInCents — Monto en centavos.
     * @param {string} options.currency — Moneda (ej: 'COP').
     * @param {string} options.reference — Referencia única.
     * @param {string} [options.redirectUrl] — URL de redirección post-pago.
     * @returns {Promise<{checkoutUrl: string, transactionId: string}>}
     */
    async createCheckout({ amountInCents, currency, reference, redirectUrl }) {
        throw new Error('IPaymentGatewayPort.createCheckout() not implemented');
    }

    /**
     * Consulta el estado de una transacción.
     * @param {string} transactionId
     * @returns {Promise<{status: string, amountInCents: number}>}
     */
    async getTransactionStatus(transactionId) {
        throw new Error('IPaymentGatewayPort.getTransactionStatus() not implemented');
    }

    /**
     * Verifica la firma de un webhook.
     * @param {object} payload — Body del webhook.
     * @param {string} signature — Firma recibida.
     * @returns {boolean}
     */
    verifyWebhookSignature(payload, signature) {
        throw new Error('IPaymentGatewayPort.verifyWebhookSignature() not implemented');
    }
}

export default IPaymentGatewayPort;