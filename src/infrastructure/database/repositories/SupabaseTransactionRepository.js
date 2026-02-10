export class SupabaseTransactionRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('transactions').select('*').eq('id', id).single();
        return error ? null : data;
    }

    async findByTransactionId(transactionId) {
        const { data, error } = await this.client.from('transactions').select('*').eq('transaction_id', transactionId).single();
        return error ? null : data;
    }

    async findByUser(userId) {
        const { data, error } = await this.client.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false });
        return error ? [] : data || [];
    }

    async findPending(userId, courseId) {
        const { data, error } = await this.client.from('transactions').select('*').eq('user_id', userId).eq('course_id', courseId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
        return error ? null : data;
    }

    async create(txData) {
        const { data, error } = await this.client.from('transactions').insert({
            user_id: txData.userId,
            course_id: txData.courseId,
            transaction_id: txData.transactionId || null,
            amount: txData.amount || 0,
            currency: txData.currency || 'COP',
            status: txData.status || 'pending',
            payment_method: txData.paymentMethod || null,
        }).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.status !== undefined) payload.status = data.status;
        if (data.transactionId !== undefined) payload.transaction_id = data.transactionId;
        if (data.gatewayResponse !== undefined) payload.gateway_response = data.gatewayResponse;
        payload.updated_at = new Date().toISOString();
        const { data: u, error } = await this.client.from('transactions').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return u;
    }

    async updateByTransactionId(transactionId, data) {
        const payload = {};
        if (data.status !== undefined) payload.status = data.status;
        if (data.gatewayResponse !== undefined) payload.gateway_response = data.gatewayResponse;
        payload.updated_at = new Date().toISOString();
        const { error } = await this.client.from('transactions').update(payload).eq('transaction_id', transactionId);
        if (error) throw new Error(error.message);
        return true;
    }

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('transactions').select('*').eq('user_id', userId).eq('course_id', courseId).order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async hasSuccessfulPurchase(userId, courseId) {
        const { count, error } = await this.client.from('transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('course_id', courseId).eq('status', 'approved');
        return !error && count > 0;
    }
}
export default SupabaseTransactionRepository;