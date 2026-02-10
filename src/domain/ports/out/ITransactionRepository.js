/**
 * ITransactionRepository — Puerto de salida para transacciones de pago.
 * @interface
 */
export class ITransactionRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByTransactionId(transactionId) { throw new Error('Not implemented'); }
    async findByUser(userId) { throw new Error('Not implemented'); }
    async findPending(userId, courseId) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async updateByTransactionId(transactionId, data) { throw new Error('Not implemented'); }
}
export default ITransactionRepository;