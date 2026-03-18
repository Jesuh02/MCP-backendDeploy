/**
 * SupabasePersonaRepository — CRUD para tabla personas.
 */
function resolveCedula(personaData = {}) {
    const raw = personaData.cedula ?? personaData.identificacion ?? null;
    if (raw === null || raw === '') return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
}

export class SupabasePersonaRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('personas').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByIdentificacion(identificacion) {
        const num = Number(identificacion);
        if (!Number.isFinite(num)) return null;
        const { data, error } = await this.client.from('personas').select('*').eq('identificacion', num).single();
        if (error || !data) return null;
        return data;
    }

    async findAll({ offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('personas').select('*').order('id', { ascending: true }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    async create(personaData) {
        const cedula = resolveCedula(personaData);
        const payload = {
            nombres: personaData.nombres,
            apellidos: personaData.apellidos || '',
            cedula,
            identificacion: cedula,
            telefono: personaData.telefono || '',
            direccion: personaData.direccion || '',
            fecha_nacimiento: personaData.fecha_nacimiento || null,
            genero: personaData.genero || null,
            ...(personaData.institucion_id != null && { institucion_id: personaData.institucion_id }),
        };
        const { data, error } = await this.client.from('personas').insert(payload).select().single();
        if (error) throw new Error(`Error creando persona: ${error.message}`);
        return data;
    }

    async update(id, personaData) {
        const payload = {};
        if (personaData.nombres !== undefined) payload.nombres = personaData.nombres;
        if (personaData.apellidos !== undefined) payload.apellidos = personaData.apellidos;
        if (personaData.cedula !== undefined || personaData.identificacion !== undefined) {
            const cedula = resolveCedula(personaData);
            payload.cedula = cedula;
            payload.identificacion = cedula;
        }
        if (personaData.telefono !== undefined) payload.telefono = personaData.telefono;
        if (personaData.direccion !== undefined) payload.direccion = personaData.direccion;
        if (personaData.fecha_nacimiento !== undefined) payload.fecha_nacimiento = personaData.fecha_nacimiento;
        if (personaData.genero !== undefined) payload.genero = personaData.genero;
        if (personaData.institucion_id !== undefined) payload.institucion_id = personaData.institucion_id;
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

