const TABLE = 'institutions';

const toApp = (row) => row && ({
    id: row.id,
    nombre: row.name,
    codigo: row.code,
    ciudad: row.city,
    departamento: row.department,
    is_active: row.is_active,
    created_at: row.created_at,
});

const toDb = ({ nombre, codigo, ciudad, departamento, is_active }) => {
    const mapped = {};
    if (nombre !== undefined) mapped.name = nombre;
    if (codigo !== undefined) mapped.code = codigo;
    if (ciudad !== undefined) mapped.city = ciudad;
    if (departamento !== undefined) mapped.department = departamento;
    if (is_active !== undefined) mapped.is_active = is_active;
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
}
export default SupabaseInstitucionRepository;
