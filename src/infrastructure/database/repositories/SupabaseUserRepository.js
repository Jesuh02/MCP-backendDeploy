/**
 * SupabaseUserRepository — Implementa IUserRepository usando Supabase PostgREST.
 */
export class SupabaseUserRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('usuarios').select('*, personas(*)').eq('id', id).single();
        if (error || !data) return null;
        return this._enrichWithRoles(data);
    }

    async findByUsername(username) {
        const { data, error } = await this.client.from('usuarios').select('*, personas(*)').ilike('username', username).single();
        if (error || !data) return null;
        return this._enrichWithRoles(data);
    }

    async findByEmail(email) {
        const { data, error } = await this.client.from('usuarios').select('*, personas(*)').ilike('email', email).single();
        if (error || !data) return null;
        return this._enrichWithRoles(data);
    }

    async create(userData) {
        // 1. Create persona first if provided
        let personaId = userData.personaId || null;
        if (userData.persona && !personaId) {
            const { data: p, error: pe } = await this.client.from('personas').insert({
                nombre: userData.persona.nombre,
                apellido: userData.persona.apellido || '',
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
            password: userData.password,
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
        if (data.password !== undefined) updatePayload.password = data.password;
        updatePayload.updated_at = new Date().toISOString();
        const { data: updated, error } = await this.client.from('usuarios').update(updatePayload).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
        return updated;
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
        const { data, error } = await this.client.from('usuarios').select('id, username, email, avatar').ilike('username', `%${query}%`).limit(limit);
        if (error) return [];
        return data || [];
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
        const { error } = await this.client.from('user_fcm_tokens').upsert({ user_id: userId, token, device_type: deviceType }, { onConflict: 'token' });
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