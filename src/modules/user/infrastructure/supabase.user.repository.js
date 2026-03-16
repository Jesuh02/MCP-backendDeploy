/**
 * SupabaseUserRepository — Implementa IUserRepository usando Supabase PostgREST.
 */
export class SupabaseUserRepository {
    constructor(client) { this.client = client; }

    /** Map DB row (contrasena) to domain model (password) */
    _mapUser(data) {
        if (!data) return null;
        const mapped = {...data, password: data.contrasena };
        delete mapped.contrasena;
        return mapped;
    }

    async findById(id) {
        // Use FK hint to disambiguate duplicate foreign keys on persona_id
        const { data, error } = await this.client.from('usuarios').select('*, personas!fk_usuarios_persona(*)').eq('id', id).maybeSingle();
        if (error) {
            console.warn(`[UserRepo] findById error (with join): ${error.message}, trying without join`);
            const { data: d2, error: e2 } = await this.client.from('usuarios').select('*').eq('id', id).maybeSingle();
            if (e2 || !d2) return null;
            return this._enrichWithRoles(this._mapUser(d2));
        }
        if (!data) return null;
        return this._enrichWithRoles(this._mapUser(data));
    }

    async findByUsername(username) {
        const { data, error } = await this.client.from('usuarios').select('*, personas!fk_usuarios_persona(*)').ilike('username', username).maybeSingle();
        if (error) {
            console.warn(`[UserRepo] findByUsername error (with join): ${error.message}, trying without join`);
            const { data: d2, error: e2 } = await this.client.from('usuarios').select('*').ilike('username', username).maybeSingle();
            if (e2 || !d2) { console.error(`[UserRepo] findByUsername fallback also failed: ${e2?.message}`); return null; }
            return this._enrichWithRoles(this._mapUser(d2));
        }
        if (!data) return null;
        return this._enrichWithRoles(this._mapUser(data));
    }

    async findByEmail(email) {
        const { data, error } = await this.client.from('usuarios').select('*, personas!fk_usuarios_persona(*)').ilike('email', email).maybeSingle();
        if (error) {
            console.warn(`[UserRepo] findByEmail error (with join): ${error.message}, trying without join`);
            const { data: d2, error: e2 } = await this.client.from('usuarios').select('*').ilike('email', email).maybeSingle();
            if (e2 || !d2) return null;
            return this._enrichWithRoles(this._mapUser(d2));
        }
        if (!data) return null;
        return this._enrichWithRoles(this._mapUser(data));
    }

    async create(userData) {
        // 1. Create persona first if provided
        let personaId = userData.personaId || null;
        if (userData.persona && !personaId) {
            const { data: p, error: pe } = await this.client.from('personas').insert({
                nombres: userData.persona.nombre || userData.persona.nombres || '',
                apellidos: userData.persona.apellido || userData.persona.apellidos || '',
                identificacion: userData.persona.identificacion || '',
                telefono: userData.persona.telefono || '',
            }).select().single();
            if (pe) throw new Error(`Error creando persona: ${pe.message}`);
            personaId = p.id;
        }
        // 2. Create usuario
        const { data, error } = await this.client.from('usuarios').insert({
            username: userData.username,
            email: userData.email,
            contrasena: userData.password,
            avatar: userData.avatar || null,
            persona_id: personaId,
        }).select().single();
        if (error) throw new Error(`Error creando usuario: ${error.message}`);
        // 3. Assign default role (1 = estudiante)
        await this.assignRole(data.id, 1);
        return {...data, roles: [{ id: 1, nombre: 'Estudiante' }] };
    }
    async update(id, data) {
        const updatePayload = {};
        if (data.username !== undefined) updatePayload.username = data.username;
        if (data.email !== undefined) updatePayload.email = data.email;
        if (data.avatar !== undefined) updatePayload.avatar = data.avatar;
        if (data.password !== undefined) updatePayload.contrasena = data.password;
        const { data: updated, error } = await this.client.from('usuarios').update(updatePayload).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
        return this._mapUser(updated);
    }
    async findAll({ limit = 100, offset = 0 } = {}) {
        const { data, error } = await this.client
            .from('usuarios')
            .select('*, personas!fk_usuarios_persona(*)')
            .order('id', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(`Error listando usuarios: ${error.message}`);
        if (!data) return [];
        const mapped = data.map(u => this._mapUser(u));
        return Promise.all(mapped.map(u => this._enrichWithRoles(u)));
    }

    async exists(username) {
        const { count, error } = await this.client.from('usuarios').select('id', { count: 'exact', head: true }).ilike('username', username);
        return !error && count > 0;
    }

    async findWithRoles(username) {
        return this.findByUsername(username);
    }

    async assignRole(userId, roleId) {
        const { error } = await this.client.from('usuarios_roles').upsert({ usuario_id: userId, rol_id: roleId }, { onConflict: 'usuario_id,rol_id' });
        if (error) throw new Error(`Error asignando rol: ${error.message}`);
        return true;
    }

    async getUserRoles(userId) {
        const { data, error } = await this.client.from('usuarios_roles').select('rol_id, roles(id, nombre)').eq('usuario_id', userId);
        if (error || !data) return [];
        return data.map(r => r.roles || { id: r.rol_id });
    }

    async searchByUsername(query, limit = 20) {
        const baseSelect = 'id, username, email, avatar, personas!fk_usuarios_persona(nombres, apellidos)';
        const innerSelect = 'id, username, email, avatar, personas!inner(nombres, apellidos)';
        const [byUsername, byNombres, byApellidos] = await Promise.all([
            this.client.from('usuarios').select(baseSelect).ilike('username', `%${query}%`).limit(limit),
            this.client.from('usuarios').select(innerSelect).ilike('personas.nombres', `%${query}%`).limit(limit),
            this.client.from('usuarios').select(innerSelect).ilike('personas.apellidos', `%${query}%`).limit(limit),
        ]);
        const seen = new Set();
        const results = [];
        for (const { data } of [byUsername, byNombres, byApellidos]) {
            for (const u of data || []) {
                if (seen.has(u.id)) continue;
                seen.add(u.id);
                results.push({
                    id: u.id,
                    username: u.username,
                    email: u.email,
                    avatar: u.avatar,
                    fullName: u.personas ? `${u.personas.nombres || ''} ${u.personas.apellidos || ''}`.trim() : null
                });
            }
        }
        return results.slice(0, limit);
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const { data, error } = await this.client.from('usuarios').select('id, username, email, avatar').in('id', ids);
        if (error) return [];
        return data || [];
    }

    async getUserFCMTokens(userId) {
        const { data, error } = await this.client.from('user_fcm_tokens').select('token').eq('user_id', userId);
        if (error || !data) return [];
        return [...new Set(data.map(t => t.token))];
    }

    async registerFCMToken(userId, token, deviceType = 'android') {
        const normalizedToken = (token || '').trim();
        if (!normalizedToken) throw new Error('Error registrando FCM token: token vacío');

        const { error } = await this.client
            .from('user_fcm_tokens')
            .upsert({ user_id: userId, token: normalizedToken, device_type: deviceType }, { onConflict: 'user_id,token' });
        if (error) throw new Error(`Error registrando FCM token: ${error.message}`);
        return true;
    }

    async removeInvalidFCMTokens(tokens) {
        if (!tokens || tokens.length === 0) return;
        await this.client.from('user_fcm_tokens').delete().in('token', tokens);
    }

    // Helper to enrich user data with roles
    async _enrichWithRoles(userData) {
        const roles = await this.getUserRoles(userData.id);
        return {...userData, roles };
    }
}
export default SupabaseUserRepository;