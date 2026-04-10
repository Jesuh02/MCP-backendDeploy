const TABLE = 'institution_payments';

const toApp = (row) => row && ({
    id: row.id,
    institution_id: row.institution_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    payment_method: row.payment_method,
    external_reference: row.external_reference,
    wompi_transaction_id: row.wompi_transaction_id,
    paid_by_user_id: row.paid_by_user_id,
    billing_period_start: row.billing_period_start,
    billing_period_end: row.billing_period_end,
    created_at: row.created_at,
    updated_at: row.updated_at,
});

export class SupabaseInstitutionPaymentRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from(TABLE).select('*').eq('id', id).single();
        if (error || !data) return null;
        return toApp(data);
    }

    async findByInstitution(institutionId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .eq('institution_id', institutionId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return (data || []).map(toApp);
    }

    async findPending(institutionId) {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .eq('institution_id', institutionId)
            .eq('status', 'PENDING')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error || !data) return null;
        return toApp(data);
    }

    async create(payload) {
        const { data, error } = await this.client.from(TABLE).insert(payload).select().single();
        if (error) throw new Error(`Error creando pago de institución: ${error.message}`);
        return toApp(data);
    }

    async update(id, payload) {
        const { data, error } = await this.client
            .from(TABLE)
            .update({ ...payload, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(`Error actualizando pago: ${error.message}`);
        return toApp(data);
    }

    async findByReference(reference) {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .eq('external_reference', reference)
            .maybeSingle();
        if (error || !data) return null;
        return toApp(data);
    }
}
export default SupabaseInstitutionPaymentRepository;
