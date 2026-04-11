export class SupabaseTransactionRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('transactions').select('*').eq('id', id).single();
        return error ? null : data;
    }

    async findByTransactionId(transactionId) {
        // Column is 'external_reference' in DB — kept for backward compatibility
        const { data, error } = await this.client.from('transactions').select('*').eq('external_reference', transactionId).single();
        return error ? null : data;
    }

    async findByUser(userId) {
        const { data, error } = await this.client.from('transactions').select('*').eq('user_id', userId).order('transaction_date', { ascending: false });
        return error ? [] : data || [];
    }

    async findPending(userId, courseId) {
        // Check for 'pending' or 'PENDING'
        const { data, error } = await this.client.from('transactions')
            .select('*')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .ilike('status', 'pending')
            .order('transaction_date', { ascending: false })
            .limit(1)
            .single();
        return error ? null : data;
    }

    async create(txData) {
        const { data, error } = await this.client.from('transactions').insert({
            user_id: txData.userId,
            course_id: txData.courseId,
            external_reference: txData.externalReference || txData.transactionId || null,
            amount: txData.amount || 0,
            currency: txData.currency || 'COP',
            status: txData.status || 'PENDING',
            payment_method: txData.paymentMethod || null,
        }).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.status !== undefined) payload.status = data.status;
        if (data.transactionId !== undefined) payload.external_reference = data.transactionId;
        if (data.externalReference !== undefined) payload.external_reference = data.externalReference;
        if (data.gatewayResponse !== undefined) payload.provider_response = data.gatewayResponse;
        payload.updated_at = new Date().toISOString();
        const { data: u, error } = await this.client.from('transactions').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return u;
    }

    async updateByTransactionId(transactionId, data) {
        const payload = {};
        if (data.status !== undefined) payload.status = data.status;
        if (data.gatewayResponse !== undefined) payload.provider_response = data.gatewayResponse;
        if (data.wompiTransactionId !== undefined) payload.wompi_transaction_id = data.wompiTransactionId;
        payload.updated_at = new Date().toISOString();
        // Column is 'external_reference' in DB
        const { error } = await this.client.from('transactions').update(payload).eq('external_reference', transactionId);
        if (error) throw new Error(error.message);
        return true;
    }

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('transactions').select('*').eq('user_id', userId).eq('course_id', courseId).order('transaction_date', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async hasSuccessfulPurchase(userId, courseId) {
        // Check for 'approved' or 'APPROVED'
        const { count, error } = await this.client.from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .ilike('status', 'approved');
        return !error && count > 0;
    }

    async countPurchased(userId) {
        // Check for 'approved' or 'APPROVED'
        const { count, error } = await this.client.from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .ilike('status', 'approved');
        return error ? 0 : count;
    }

    async findPurchasedCourseIdsPaginated(userId, { offset = 0, limit = 20 } = {}) {
        // Check for 'approved' or 'APPROVED'
        const { data, error } = await this.client.from('transactions')
            .select('course_id')
            .eq('user_id', userId)
            .ilike('status', 'approved')
            .order('transaction_date', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data.map(t => t.course_id);
    }

    async findPurchasedCourseIds(userId) {
        // Check for 'approved' or 'APPROVED'
        const { data, error } = await this.client.from('transactions')
            .select('course_id')
            .eq('user_id', userId)
            .ilike('status', 'approved');
        if (error) return [];
        return data.map(t => t.course_id);
    }

    async findPendingByAmount(amountInPesos) {
        const { data, error } = await this.client.from('transactions')
            .select('*')
            .ilike('status', 'pending')
            .eq('amount', amountInPesos)
            .order('transaction_date', { ascending: false })
            .limit(5);
        return error ? [] : data || [];
    }

    async findByExternalReference(reference) {
        const { data, error } = await this.client.from('transactions')
            .select('*')
            .eq('external_reference', reference)
            .maybeSingle();
        return error ? null : data;
    }

    async updateByExternalReference(reference, data) {
        const payload = {};
        if (data.status !== undefined) payload.status = data.status;
        if (data.gatewayResponse !== undefined) payload.provider_response = data.gatewayResponse;
        if (data.wompiTransactionId !== undefined) payload.wompi_transaction_id = data.wompiTransactionId;
        payload.updated_at = new Date().toISOString();
        const { error } = await this.client.from('transactions').update(payload).eq('external_reference', reference);
        if (error) throw new Error(error.message);
        return true;
    }

    /**
     * Find transaction by reference in either column (transaction_id or external_reference)
     */
    async findByReference(reference) {
        // Try transaction_id first
        let result = await this.findByTransactionId(reference);
        if (result) return result;
        // Fallback to external_reference
        return await this.findByExternalReference(reference);
    }

    /**
     * Update transaction by reference in either column (transaction_id or external_reference)
     */
    async updateByReference(reference, data) {
        // Try transaction_id first
        const tx = await this.findByTransactionId(reference);
        if (tx) {
            return await this.updateByTransactionId(reference, data);
        }
        // Fallback to external_reference
        const txByRef = await this.findByExternalReference(reference);
        if (txByRef) {
            return await this.updateByExternalReference(reference, data);
        }
        console.warn(`⚠️ Transaction not found by reference: ${reference}`);
        return false;
    }

    // ═══════════════════════════════════════════════════════
    // Service payments (institution billing via transactions)
    // ═══════════════════════════════════════════════════════

    async findServicePaymentsByInstitution(institutionId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client
            .from('transactions')
            .select('*')
            .eq('institution_id', institutionId)
            .eq('payment_type', 'service')
            .order('transaction_date', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    async findPendingServicePayment(institutionId, userId = null) {
        // First: search for ANY pending service payment for this institution (regardless of user)
        // to prevent duplicate payments even if different admin users trigger the flow.
        const { data: anyPending, error: anyErr } = await this.client
            .from('transactions')
            .select('*')
            .eq('institution_id', institutionId)
            .eq('payment_type', 'service')
            .ilike('status', 'pending')
            .order('transaction_date', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!anyErr && anyPending) return anyPending;

        // Fallback: search by user_id if provided (shouldn't be needed but keeps compatibility)
        if (userId) {
            const { data, error } = await this.client
                .from('transactions')
                .select('*')
                .eq('institution_id', institutionId)
                .eq('payment_type', 'service')
                .eq('user_id', userId)
                .ilike('status', 'pending')
                .order('transaction_date', { ascending: false })
                .limit(1)
                .maybeSingle();
            return (error || !data) ? null : data;
        }
        return null;
    }

    /**
     * Check if an APPROVED service payment already exists for a given institution
     * (and optionally a specific user) to prevent duplicate payments.
     */
    async hasApprovedServicePayment(institutionId, userId = null) {
        let query = this.client
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('institution_id', institutionId)
            .eq('payment_type', 'service')
            .ilike('status', 'approved');
        if (userId) query = query.eq('user_id', userId);
        const { count, error } = await query;
        return !error && count > 0;
    }

    async createServicePayment(payload) {
        // Prevent duplicate: reuse existing PENDING payment for same institution + user
        const existing = await this.findPendingServicePayment(
            payload.institutionId,
            payload.userId || null
        );
        if (existing) {
            return await this.update(existing.id, {
                externalReference: payload.externalReference,
                amount: payload.amount || existing.amount,
            });
        }

        const row = {
            institution_id: payload.institutionId,
            external_reference: payload.externalReference || null,
            amount: payload.amount || 0,
            currency: payload.currency || 'COP',
            status: payload.status || 'PENDING',
            payment_method: payload.paymentMethod || 'wompi',
            payment_type: 'service',
            billing_period_start: payload.billingPeriodStart || null,
            billing_period_end: payload.billingPeriodEnd || null,
        };
        // Only include user_id/course_id if they have a real value,
        // so the INSERT works whether the columns are nullable or NOT NULL.
        if (payload.userId) row.user_id = payload.userId;
        if (payload.courseId) row.course_id = payload.courseId;
        const { data, error } = await this.client.from('transactions').insert(row).select().single();
        if (error) throw new Error(`Error creando pago de servicio: ${error.message}`);
        return data;
    }

    async findAllServicePayments({ offset = 0, limit = 200 } = {}) {
        const { data, error } = await this.client
            .from('transactions')
            .select('*')
            .eq('payment_type', 'service')
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseTransactionRepository;

