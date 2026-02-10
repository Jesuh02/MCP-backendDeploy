/**
 * SupabasePersonaRepository — CRUD para tabla personas.
 */
export class SupabasePersonaRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('personas').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByIdentificacion(identificacion) {
        const { data, error } = await this.client.from('personas').select('*').eq('identificacion', identificacion).single();
        if (error || !data) return null;
        return data;
    }

    async findAll({ offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('personas').select('*').order('id', { ascending: true }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    async create(personaData) {
        const payload = {
            nombre: personaData.nombre,
            apellido: personaData.apellido || '',
            identificacion: personaData.identificacion || '',
            telefono: personaData.telefono || '',
        };
        const { data, error } = await this.client.from('personas').insert(payload).select().single();
        if (error) throw new Error(`Error creando persona: ${error.message}`);
        return data;
    }

    async update(id, personaData) {
        const payload = {};
        if (personaData.nombre !== undefined) payload.nombre = personaData.nombre;
        if (personaData.apellido !== undefined) payload.apellido = personaData.apellido;
        if (personaData.identificacion !== undefined) payload.identificacion = personaData.identificacion;
        if (personaData.telefono !== undefined) payload.telefono = personaData.telefono;
        const { data, error } = await this.client.from('personas').update(payload).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando persona: ${error.message}`);
        return data;
    }

    async delete(id) {
        const { error } = await this.client.from('personas').delete().eq('id', id);
        if (error) throw new Error(`Error eliminando persona: ${error.message}`);
        return true;
    }

    async count() {
        const { count, error } = await this.client.from('personas').select('id', { count: 'exact', head: true });
        return error ? 0 : count;
    }
}
export default SupabasePersonaRepository;