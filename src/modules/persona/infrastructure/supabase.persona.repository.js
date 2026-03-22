/**
 * SupabasePersonaRepository — CRUD para tabla personas.
 */
function normalizeCedulaValue(value) {
    if (value === null || value === undefined) return null;
    const digitsOnly = String(value).replace(/\D/g, '').trim();
    return digitsOnly || null;
}

function resolveCedula(personaData = {}) {
    const raw = personaData.cedula ?? personaData.identificacion ?? null;
    return normalizeCedulaValue(raw);
}

export class SupabasePersonaRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('personas').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByIdentificacion(identificacion) {
        const normalized = normalizeCedulaValue(identificacion);
        if (!normalized) return null;
        const numericId = parseInt(normalized, 10);
        if (isNaN(numericId) || numericId <= 0) return null;
        const { data, error } = await this.client
            .from('personas')
            .select('*')
            .or(`identificacion.eq.${numericId},identificacion_original.eq.${normalized}`)
            .maybeSingle();
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
            identificacion: cedula ? parseInt(cedula, 10) : null,
            identificacion_original: cedula || null,
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
            payload.identificacion = cedula ? parseInt(cedula, 10) : null;
            payload.identificacion_original = cedula || null;
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

    async searchByIdentificacion(query, limit = 20) {
        const digits = String(query || '').replace(/\D/g, '').trim();
        if (!digits) return [];
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

        const searches = [
            // Partial match on text column
            this.client.from('personas').select('*').ilike('identificacion_original', `%${digits}%`).limit(safeLimit),
        ];
        // Exact match on bigint column
        const numericId = parseInt(digits, 10);
        if (!isNaN(numericId) && numericId > 0) {
            searches.push(this.client.from('personas').select('*').eq('identificacion', numericId).limit(safeLimit));
        }

        const results = await Promise.all(searches);
        const seen = new Set();
        const personas = [];
        for (const { data } of results) {
            for (const p of data || []) {
                if (seen.has(p.id)) continue;
                seen.add(p.id);
                personas.push(p);
                if (personas.length >= safeLimit) break;
            }
            if (personas.length >= safeLimit) break;
        }
        return personas;
    }

    async count() {
        const { count, error } = await this.client.from('personas').select('id', { count: 'exact', head: true });
        return error ? 0 : count;
    }

    /**
     * Returns persona names for a list of user IDs.
     * Joins usuarios.persona_id → personas to get nombres + apellidos.
     * Returns [{ userId, nombres, apellidos, fullName }]
     */
    async findByUserIds(userIds) {
        if (!userIds?.length) return [];
        const safeIds = [...new Set(userIds.map(Number).filter(n => Number.isFinite(n) && n > 0))];
        if (!safeIds.length) return [];

        const { data: users, error: userErr } = await this.client
            .from('usuarios')
            .select('id, persona_id')
            .in('id', safeIds);
        if (userErr || !users?.length) return [];

        const personaIdToUserId = new Map();
        const personaIds = [];
        for (const u of users) {
            if (u.persona_id) {
                personaIdToUserId.set(Number(u.persona_id), Number(u.id));
                personaIds.push(Number(u.persona_id));
            }
        }
        if (!personaIds.length) return [];

        const { data: personas, error: personaErr } = await this.client
            .from('personas')
            .select('id, nombres, apellidos')
            .in('id', personaIds);
        if (personaErr || !personas?.length) return [];

        return personas
            .map(p => ({
                userId:    personaIdToUserId.get(Number(p.id)),
                nombres:   p.nombres   || '',
                apellidos: p.apellidos || '',
                fullName:  [p.nombres, p.apellidos].filter(Boolean).join(' ').trim(),
            }))
            .filter(r => r.userId != null);
    }

    /**
     * Search personas by nombres or apellidos (case-insensitive partial match).
     */
    async searchByName(query, limit = 20) {
        const q = String(query || '').trim();
        if (!q) return [];
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const { data, error } = await this.client
            .from('personas')
            .select('*')
            .or(`nombres.ilike.%${q}%,apellidos.ilike.%${q}%`)
            .limit(safeLimit);
        if (error || !data?.length) return [];
        return data;
    }
}
export default SupabasePersonaRepository;

