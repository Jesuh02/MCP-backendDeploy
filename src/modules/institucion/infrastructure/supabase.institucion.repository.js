const TABLE = 'institutions';

const toApp = (row) => row && ({
    id: row.id,
    nombre: row.name,
    codigo: row.code,
    ciudad: row.city,
    departamento: row.department,
    is_active: row.is_active,
    payment_due_date: row.payment_due_date || null,
    is_suspended: row.is_suspended || false,
    suspended_at: row.suspended_at || null,
    suspended_reason: row.suspended_reason || null,
    created_at: row.created_at,
});

const toDb = ({ nombre, codigo, ciudad, departamento, is_active, payment_due_date, is_suspended, suspended_at, suspended_reason }) => {
    const mapped = {};
    if (nombre !== undefined) mapped.name = nombre;
    if (codigo !== undefined) mapped.code = codigo;
    if (ciudad !== undefined) mapped.city = ciudad;
    if (departamento !== undefined) mapped.department = departamento;
    if (is_active !== undefined) mapped.is_active = is_active;
    if (payment_due_date !== undefined) mapped.payment_due_date = payment_due_date;
    if (is_suspended !== undefined) mapped.is_suspended = is_suspended;
    if (suspended_at !== undefined) mapped.suspended_at = suspended_at;
    if (suspended_reason !== undefined) mapped.suspended_reason = suspended_reason;
    return mapped;
};

export class SupabaseInstitucionRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from(TABLE).select('*').eq('id', id).single();
        if (error || !data) return null;
        return toApp(data);
    }

    async findAll({ offset = 0, limit = 100 } = {}) {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .eq('is_active', true)
            .order('name', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return (data || []).map(toApp);
    }

    async search(query, { limit = 20 } = {}) {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .eq('is_active', true)
            .ilike('name', `%${query}%`)
            .order('name', { ascending: true })
            .limit(limit);
        if (error) return [];
        return (data || []).map(toApp);
    }

    async create(payload) {
        const { data, error } = await this.client.from(TABLE).insert(toDb(payload)).select().single();
        if (error) throw new Error(`Error creando institución: ${error.message}`);
        return toApp(data);
    }

    async update(id, payload) {
        const { data, error } = await this.client.from(TABLE).update(toDb(payload)).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando institución: ${error.message}`);
        return toApp(data);
    }

    async delete(id) {
        const { error } = await this.client.from(TABLE).update({ is_active: false }).eq('id', id);
        if (error) throw new Error(`Error eliminando institución: ${error.message}`);
        return true;
    }

    /** Fetch ALL institutions (including inactive/suspended) for superadmin. */
    async findAllUnfiltered({ offset = 0, limit = 200 } = {}) {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .order('name', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return (data || []).map(toApp);
    }

    /** Set payment due date for an institution. */
    async setPaymentDueDate(id, dueDate) {
        const { data, error } = await this.client
            .from(TABLE)
            .update({ payment_due_date: dueDate })
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(`Error actualizando fecha de pago: ${error.message}`);
        return toApp(data);
    }

    /** Suspend an institution (deactivate all users). */
    async suspend(id, reason = null) {
        const { data, error } = await this.client
            .from(TABLE)
            .update({ is_suspended: true, suspended_at: new Date().toISOString(), suspended_reason: reason })
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(`Error suspendiendo institución: ${error.message}`);
        return toApp(data);
    }

    /** Reactivate a suspended institution. */
    async unsuspend(id) {
        const { data, error } = await this.client
            .from(TABLE)
            .update({ is_suspended: false, suspended_at: null, suspended_reason: null })
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(`Error reactivando institución: ${error.message}`);
        return toApp(data);
    }

    /** Find institutions with overdue payment. */
    async findOverduePayment() {
        const { data, error } = await this.client
            .from(TABLE)
            .select('*')
            .eq('is_active', true)
            .lt('payment_due_date', new Date().toISOString())
            .not('payment_due_date', 'is', null);
        if (error) return [];
        return (data || []).map(toApp);
    }
}
export default SupabaseInstitucionRepository;
