/**
 * WompiAdapter — Implementa IPaymentGatewayPort.
 * Encapsula la integración con Wompi (PSE / Colombia).
 */
import crypto from 'crypto';

export class WompiAdapter {
    constructor() {
        const privateKey = process.env.PAYU_API_KEY || '';
        const isTest = privateKey.startsWith('prv_test_');

        this.privateKey = privateKey;
        this.publicKey = process.env.PAYU_PUBLIC_KEY || '';
        this.integritySecret = process.env.PAYU_INTEGRITY_SECRET || '';
        this.eventSecret = process.env.PAYU_EVENT_SECRET || '';
        this.baseUrl = isTest ?
            'https://sandbox.wompi.co/v1' :
            'https://production.wompi.co/v1';

        if (this.privateKey && this.publicKey) {
            console.log(`✅ WompiAdapter: Initialized (${isTest ? 'SANDBOX' : 'PRODUCTION'})`);
        } else {
            console.warn('⚠️ WompiAdapter: Missing payment credentials');
        }
    }

    // ----------------------------------------------------------
    // IPaymentGatewayPort
    // ----------------------------------------------------------

    /**
     * Inicia un pago PSE vía Wompi Checkout URL.
     * @param {{ amountInCents: number, currency: string, reference: string, redirectUrl: string }} opts
     * @returns {Promise<{ checkoutUrl: string, reference: string, signature: string }>}
     */
    async initiatePayment({ amountInCents, currency = 'COP', reference, redirectUrl }) {
        const signature = this._generateSignature(reference, amountInCents, currency);
        const checkoutUrl = `https://checkout.wompi.co/p/?public-key=${this.publicKey}` +
            `&currency=${currency}` +
            `&amount-in-cents=${amountInCents}` +
            `&reference=${reference}` +
            `&redirect-url=${encodeURIComponent(redirectUrl)}` +
            `&signature:integrity=${signature}`;

        return { checkoutUrl, reference, signature };
    }

    /**
     * Consulta el estado de una transacción en Wompi.
     * @param {string} transactionId — ID de transacción Wompi
     * @returns {Promise<Object>}
     */
    async getTransactionStatus(transactionId) {
        const resp = await fetch(`${this.baseUrl}/transactions/${transactionId}`, {
            headers: { Authorization: `Bearer ${this.privateKey}` },
        });
        const json = await resp.json();
        return json.data || json;
    }

    /**
     * Obtiene la lista de bancos disponibles para PSE.
     * @returns {Promise<Object[]>}
     */
    async getBanks() {
        const resp = await fetch(`${this.baseUrl}/pse/financial_institutions`, {
            headers: { Authorization: `Bearer ${this.privateKey}` },
        });
        const json = await resp.json();
        return json.data || [];
    }

    isAvailable() {
        return !!(this.privateKey && this.publicKey);
    }

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------

    /**
     * Verifica la firma de un evento webhook de Wompi.
     */
    verifyWebhookSignature(payload, receivedSignature) {
        if (!this.eventSecret) return false;
        const toSign = `${payload.transaction.id}${payload.transaction.status}${payload.transaction.amount_in_cents}`;
        const hmac = crypto.createHmac('sha256', this.eventSecret).update(toSign).digest('hex');
        return hmac === receivedSignature;
    }

    _generateSignature(reference, amountInCents, currency) {
        const data = `${reference}${amountInCents}${currency}${this.integritySecret}`;
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    async getAcceptanceToken() {
        const resp = await fetch(`${this.baseUrl}/merchants/${this.publicKey}`);
        const json = await resp.json();
        return json?.data?.presigned_acceptance?.acceptance_token || null;
    }
}

export default WompiAdapter;