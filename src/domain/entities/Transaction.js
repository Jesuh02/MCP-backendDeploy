/**
 * Transaction — Transacción de pago.
 */
export class Transaction {
    constructor({ id = null, userId, courseId, transactionId = null, amount = 0, currency = 'COP', status = 'pending', paymentMethod = null, gatewayResponse = null, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, userId, courseId, transactionId, amount, currency, status, paymentMethod, gatewayResponse, createdAt, updatedAt });
    }
    static fromSupabaseRow(row) {
        return new Transaction({
            id: row.id,
            userId: row.user_id || row.userId,
            courseId: row.course_id || row.courseId,
            transactionId: row.transaction_id || row.transactionId || null,
            amount: row.amount || 0,
            currency: row.currency || 'COP',
            status: row.status || 'pending',
            paymentMethod: row.payment_method || null,
            gatewayResponse: row.gateway_response || null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default Transaction;