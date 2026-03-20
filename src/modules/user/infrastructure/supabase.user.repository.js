/**
 * SupabaseUserRepository — Implementa IUserRepository usando Supabase PostgREST.
 */
export class SupabaseUserRepository {
    constructor(client) { this.client = client; }

    _normalizeSearchText(value) {
        return String(value || '').trim().toLowerCase();
    }

    _normalizeDigits(value) {
        return String(value || '').replace(/\D/g, '').trim();
    }

    _extractPersonaDocument(persona) {
        if (!persona) return '';
        const rawValue = persona.cedula ?? persona.identificacion_original ?? persona.identificacion ?? '';
        return String(rawValue || '').trim();
    }

    _attachPersonaAliases(userData) {
        if (!userData) return null;
        const persona = userData.persona ?? userData.personas ?? null;
        const personaId = userData.personaId ?? userData.persona_id ?? persona?.id ?? null;
        return {
            ...userData,
            persona,
            personas: persona,
            personaId,
        };
    }

    async _fetchPersonasByIds(personaIds = []) {
        const uniqueIds = [...new Set((personaIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
        if (uniqueIds.length === 0) return new Map();

        const { data, error } = await this.client.from('personas').select('*').in('id', uniqueIds);
        if (error || !Array.isArray(data)) return new Map();

        return new Map(data.map((persona) => [Number(persona.id), persona]));
    }

    /** Map DB row (contrasena) to domain model (password) */
    _mapUser(data) {
        if (!data) return null;
        const mapped = {...data, password: data.contrasena };
        delete mapped.contrasena;
        // Expose is_active also as isActive for frontend clients
        if (mapped.is_active !== undefined) mapped.isActive = mapped.is_active;
        return this._attachPersonaAliases(mapped);
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
            const cedula = userData.persona.cedula ?? userData.persona.identificacion ?? null;
            const cedulaDigits = cedula ? String(cedula).replace(/\D/g, '').trim() : null;
            const { data: p, error: pe } = await this.client.from('personas').insert({
                nombres: userData.persona.nombres || userData.persona.nombre || '',
                apellidos: userData.persona.apellidos || userData.persona.apellido || '',
                identificacion: cedulaDigits ? parseInt(cedulaDigits, 10) : null,
                identificacion_original: cedulaDigits || null,
                telefono: userData.persona.telefono || '',
                direccion: '',
                fecha_nacimiento: userData.persona.fecha_nacimiento || null,
                ...(userData.persona.institucion_id != null && { institucion_id: userData.persona.institucion_id }),
            }).select().single();
            if (pe) {
                console.error('[UserRepo] Error creando persona:', pe.message, pe.details, pe.hint);
                throw new Error(`Error creando persona: ${pe.message}`);
            }
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
        if (data.is_active !== undefined) updatePayload.is_active = data.is_active;
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
        let rows = data || [];

        if (error) {
            console.warn(`[UserRepo] findAll error (with join): ${error.message}, trying without join`);
            const { data: fallbackRows, error: fallbackError } = await this.client
                .from('usuarios')
                .select('*')
                .order('id', { ascending: true })
                .range(offset, offset + limit - 1);
            if (fallbackError) throw new Error(`Error listando usuarios: ${fallbackError.message}`);

            const personaMap = await this._fetchPersonasByIds((fallbackRows || []).map((user) => user.persona_id));
            rows = (fallbackRows || []).map((user) => ({
                ...user,
                personas: personaMap.get(Number(user.persona_id)) ?? null,
            }));
        }

        const mapped = rows.map((u) => this._mapUser(u));
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
        const normalizedQuery = this._normalizeSearchText(query);
        const digitsOnly = this._normalizeDigits(query);
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const textSearchLimit = Math.max(safeLimit * 2, 40);
        const baseSelect = 'id, username, email, avatar, persona_id, personas!fk_usuarios_persona(*)';

        // Text-based searches (username, email, nombres, apellidos)
        const textSearches = [
            this.client.from('usuarios').select(baseSelect).ilike('username', `%${normalizedQuery}%`).limit(textSearchLimit),
            this.client.from('usuarios').select(baseSelect).ilike('email', `%${normalizedQuery}%`).limit(textSearchLimit),
            this.client.from('usuarios').select(baseSelect).ilike('personas.nombres', `%${normalizedQuery}%`).limit(textSearchLimit),
            this.client.from('usuarios').select(baseSelect).ilike('personas.apellidos', `%${normalizedQuery}%`).limit(textSearchLimit),
        ];

        // If the query contains digits, search directly in personas table then join users.
        // This avoids unreliable embedded-resource filter syntax (personas.identificacion=eq.X)
        // which can fail silently when PostgREST FK resolution is ambiguous.
        const identificationPromise = digitsOnly
            ? (async () => {
                const numericId = parseInt(digitsOnly, 10);
                const orParts = [`identificacion_original.ilike.%${digitsOnly}%`];
                if (!isNaN(numericId) && numericId > 0) orParts.push(`identificacion.eq.${numericId}`);
                // Fetch full persona rows (not just id) so we can attach them manually
                // and avoid relying on the FK-hint join, which can fail silently.
                const { data: matchedPersonas } = await this.client
                    .from('personas').select('*').or(orParts.join(',')).limit(safeLimit);
                if (!matchedPersonas?.length) return { data: [] };
                const personaById = new Map(matchedPersonas.map(p => [p.id, p]));
                const personaIds = matchedPersonas.map(p => p.id);
                const { data: usersRaw } = await this.client
                    .from('usuarios')
                    .select('id, username, email, avatar, persona_id')
                    .in('persona_id', personaIds)
                    .limit(safeLimit);
                if (!usersRaw?.length) return { data: [] };
                // Attach persona manually — no FK-hint needed
                return { data: usersRaw.map(u => ({ ...u, personas: personaById.get(u.persona_id) ?? null })) };
            })()
            : Promise.resolve({ data: [] });

        const [textResults, identResult] = await Promise.all([Promise.all(textSearches), identificationPromise]);
        const searchResults = [...textResults, identResult];
        const seen = new Set();
        const userIds = [];
        const userMap = new Map();

        const matchesQuery = (u) => {
            const persona = u.personas ?? u.persona ?? null;
            const username = this._normalizeSearchText(u.username);
            const email = this._normalizeSearchText(u.email);
            const fullName = this._normalizeSearchText(`${persona?.nombres || ''} ${persona?.apellidos || ''}`);
            const documentDigits = this._normalizeDigits(this._extractPersonaDocument(persona));
            const textMatches = [username, email, fullName].some((value) => value.includes(normalizedQuery));

            if (!digitsOnly) return textMatches;
            return textMatches || (documentDigits.length > 0 && documentDigits.includes(digitsOnly));
        };

        for (const { data } of searchResults) {
            for (const u of data || []) {
                if (seen.has(u.id)) continue;
                if (!matchesQuery(u)) continue;
                const persona = u.personas ?? u.persona ?? null;
                seen.add(u.id);
                userIds.push(u.id);
                userMap.set(u.id, {
                    id: u.id,
                    username: u.username,
                    email: u.email,
                    avatar: u.avatar,
                    persona,
                    personas: persona,
                    personaId: u.persona_id ?? persona?.id ?? null,
                    fullName: persona ? `${persona.nombres || ''} ${persona.apellidos || ''}`.trim() : null,
                    identificacion: persona?.identificacion ?? persona?.cedula ?? persona?.identificacion_original ?? null,
                    roles: []
                });
                if (userMap.size >= safeLimit) break;
            }
            if (userMap.size >= safeLimit) break;
        }
        // Fetch roles for all found users
        if (userIds.length > 0) {
            const { data: rolesData } = await this.client
                .from('usuarios_roles')
                .select('usuario_id, rol_id, roles(id, nombre)')
                .in('usuario_id', userIds);
            if (rolesData) {
                for (const r of rolesData) {
                    const user = userMap.get(r.usuario_id);
                    if (user && r.roles) {
                        user.roles.push({ id: r.roles.id, nombre: r.roles.nombre });
                    }
                }
            }
        }
        return Array.from(userMap.values()).slice(0, safeLimit);
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const { data, error } = await this.client
            .from('usuarios')
            .select('*, personas!fk_usuarios_persona(*)')
            .in('id', ids);
        if (error) {
            console.warn(`[UserRepo] findByIds error (with join): ${error.message}, trying without join`);
            const { data: d2, error: e2 } = await this.client.from('usuarios').select('*').in('id', ids);
            if (e2 || !d2) return [];
            return d2.map(u => this._mapUser(u));
        }
        return (data || []).map(u => this._mapUser(u));
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

    async removeFCMToken(userId, token) {
        const normalizedToken = (token || '').trim();
        if (!normalizedToken) return;
        await this.client.from('user_fcm_tokens').delete().eq('user_id', userId).eq('token', normalizedToken);
    }

    async findUserIdsByRoleId(roleId) {
        const { data, error } = await this.client
            .from('usuarios_roles')
            .select('usuario_id')
            .eq('rol_id', roleId);
        if (error || !data) return [];
        return data.map(r => r.usuario_id);
    }

    // Helper to enrich user data with roles
    async _enrichWithRoles(userData) {
        const roles = await this.getUserRoles(userData.id);
        return {...userData, roles };
    }
}
export default SupabaseUserRepository;