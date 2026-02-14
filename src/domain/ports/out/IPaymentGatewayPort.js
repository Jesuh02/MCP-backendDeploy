/**
 * IPaymentGatewayPort — Puerto de salida para gateway de pago (Wompi).
 * @interface
 */
export class IPaymentGatewayPort {
    async initiatePayment(paymentData) { throw new Error('Not implemented'); }
    async getTransactionStatus(transactionId) { throw new Error('Not implemented'); }
    async getBanks() { throw new Error('Not implemented'); }
    isAvailable() { throw new Error('Not implemented'); }
}
export default IPaymentGatewayPort;

