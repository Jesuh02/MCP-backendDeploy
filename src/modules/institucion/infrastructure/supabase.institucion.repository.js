export class SupabaseInstitucionRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('instituciones').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findAll({ offset = 0, limit = 100 } = {}) {
        const { data, error } = await this.client
            .from('instituciones')
            .select('*')
            .eq('is_active', true)
            .order('nombre', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    async search(query, { limit = 20 } = {}) {
        const { data, error } = await this.client
            .from('instituciones')
            .select('*')
            .eq('is_active', true)
            .ilike('nombre', `%${query}%`)
            .order('nombre', { ascending: true })
            .limit(limit);
        if (error) return [];
        return data || [];
    }

    async create(payload) {
        const { data, error } = await this.client.from('instituciones').insert(payload).select().single();
        if (error) throw new Error(`Error creando institución: ${error.message}`);
        return data;
    }

    async update(id, payload) {
        const { data, error } = await this.client.from('instituciones').update(payload).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando institución: ${error.message}`);
        return data;
    }

    async delete(id) {
        const { error } = await this.client.from('instituciones').update({ is_active: false }).eq('id', id);
        if (error) throw new Error(`Error eliminando institución: ${error.message}`);
        return true;
    }
}
export default SupabaseInstitucionRepository;
