import crypto from 'crypto';

function normalizeEmail(email) {
    if (!email) return null;
    const normalized = String(email).trim().toLowerCase();
    return normalized || null;
}

/**
 * Hash determinístico SHA-256 para cédulas (solo dígitos).
 * Usado cuando la persona se crea inline en UserRepository.
 */
function hashCedula(digits) {
    if (!digits) return null;
    const d = String(digits).replace(/\D/g, '').trim();
    if (!d) return null;
    return crypto.createHash('sha256').update(d).digest('hex');
}

/**
 * HMAC-SHA256 determinístico para verificar unicidad de contraseñas entre usuarios.
 * Usa un pepper del entorno para que el hash no sea reversible sin la clave.
 */
const PASSWORD_FINGERPRINT_PEPPER =
    process.env.PASSWORD_FINGERPRINT_PEPPER ||
    (process.env.JWT_SECRET || 'coursev-default') + '-pwd-fp';

export function hashPasswordFingerprint(password) {
    if (!password) return null;
    return crypto.createHmac('sha256', PASSWORD_FINGERPRINT_PEPPER).update(password).digest('hex');
}

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
        // Prefer the numeric identificacion (bigint) — most reliable for digit-based matching.
        // identificacion_original can be a non-numeric token like "jesus_duplicate_5",
        // whose extracted digits ("5") would never match the real cedula "1006617028".
        if (persona.identificacion && persona.identificacion !== 0) {
            return String(persona.identificacion);
        }
        const rawValue = persona.cedula ?? persona.identificacion_original ?? '';
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
        const normalized = normalizeEmail(email);
        if (!normalized) return null;

        // 1. Buscar por email en texto plano
        const { data, error } = await this.client.from('usuarios').select('*, personas!fk_usuarios_persona(*)').ilike('email', normalized).maybeSingle();
        if (!error && data) return this._enrichWithRoles(this._mapUser(data));
        if (error) console.warn(`[UserRepo] findByEmail error: ${error.message}`);

        // 2. Fallback sin join (por si falla la FK)
        const { data: d2, error: e2 } = await this.client.from('usuarios').select('*').ilike('email', normalized).maybeSingle();
        if (e2 || !d2) return null;
        return this._enrichWithRoles(this._mapUser(d2));
    }

    /**
     * Busca si ya existe un usuario con el mismo fingerprint de contraseña.
     * Requiere la columna password_fingerprint en la tabla usuarios.
     * Retorna null (sin lanzar) si la columna no existe aún.
     */
    async findByPasswordFingerprint(fingerprint) {
        if (!fingerprint) return null;
        try {
            const { data, error } = await this.client
                .from('usuarios')
                .select('id')
                .eq('password_fingerprint', fingerprint)
                .maybeSingle();
            if (error) return null; // column may not exist yet
            return data || null;
        } catch {
            return null;
        }
    }

    async create(userData) {
        // 1. Create persona first if provided
        let personaId = userData.personaId || null;
        if (userData.persona && !personaId) {
            const cedula = userData.persona.cedula ?? userData.persona.identificacion ?? null;
            const cedulaDigits = cedula ? String(cedula).replace(/\D/g, '').trim() : null;

            // If cedula provided, check if a persona with that cedula already exists (e.g. from a previous partial attempt)
            if (cedulaDigits) {
                const existingCedulaHash = hashCedula(cedulaDigits);
                const { data: existing } = await this.client
                    .from('personas')
                    .select('id, identificacion')
                    .eq('identificacion_original', existingCedulaHash)
                    .maybeSingle();
                if (existing) {
                    console.log(`[UserRepo] Reusing existing persona id=${existing.id} for cedula ${cedulaDigits}`);
                    personaId = existing.id;
                    // Fix: if the existing persona has no numeric identificacion, patch it now
                    if (existing.identificacion === null || existing.identificacion === undefined) {
                        const numericId = Number(cedulaDigits);
                        if (Number.isFinite(numericId)) {
                            await this.client.from('personas').update({ identificacion: numericId }).eq('id', existing.id);
                            console.log(`[UserRepo] Patched identificacion=${numericId} on persona id=${existing.id}`);
                        }
                    }
                }
            }

            if (!personaId) {
                const hashedCedula = hashCedula(cedulaDigits);
                const telefonoPlain = userData.persona.telefono ? String(userData.persona.telefono).trim() : null;
                const numericCedula = cedulaDigits ? Number(cedulaDigits) : null;
                const identificacionValue = Number.isFinite(numericCedula) ? numericCedula : null;
                console.log(`[UserRepo] Creating persona: cedulaDigits=${cedulaDigits}, numericCedula=${numericCedula}, isFinite=${Number.isFinite(numericCedula)}, identificacion=${identificacionValue}`);
                const { data: p, error: pe } = await this.client.from('personas').insert({
                    nombres: userData.persona.nombres || userData.persona.nombre || '',
                    apellidos: userData.persona.apellidos || userData.persona.apellido || '',
                    identificacion: identificacionValue,
                    identificacion_original: hashedCedula || null,
                    telefono: telefonoPlain || '',
                    direccion: '',
                    fecha_nacimiento: userData.persona.fecha_nacimiento || null,
                    ...(userData.persona.institucion_id != null && { institucion_id: userData.persona.institucion_id }),
                }).select().single();
                if (pe) {
                    console.error('[UserRepo] Error creando persona:', pe.message, pe.details, pe.hint);
                    throw new Error(`Error creando persona: ${pe.message}`);
                }
                // Defensive: if identificacion was not stored, patch it now
                if ((p.identificacion === null || p.identificacion === undefined) && cedulaDigits) {
                    const patchValue = Number(cedulaDigits);
                    if (Number.isFinite(patchValue)) {
                        console.warn(`[UserRepo] identificacion was NULL after insert for persona id=${p.id}, patching to ${patchValue}`);
                        const { error: patchErr } = await this.client.from('personas').update({ identificacion: patchValue }).eq('id', p.id);
                        if (!patchErr) p.identificacion = patchValue;
                        else console.error(`[UserRepo] Patch failed for persona id=${p.id}:`, patchErr.message);
                    }
                }
                personaId = p.id;
            }
        }
        // 2. Create usuario (sin fingerprint para máxima compatibilidad)
        const { data, error } = await this.client.from('usuarios').insert({
            username: userData.username,
            email: normalizeEmail(userData.email),
            contrasena: userData.password,
            avatar: userData.avatar || null,
            persona_id: personaId,
        }).select().single();
        if (error) throw new Error(`Error creando usuario: ${error.message}`);
        // 3. Assign default role (1 = estudiante)
        await this.assignRole(data.id, 1);
        // 4. Almacenar fingerprint de contraseña (requiere migración DB; falla silenciosamente)
        if (userData.passwordFingerprint) {
            const { error: fpErr } = await this.client
                .from('usuarios')
                .update({ password_fingerprint: userData.passwordFingerprint })
                .eq('id', data.id);
            if (fpErr) {
                console.warn('[UserRepo] password_fingerprint no almacenado (¿falta la columna?):', fpErr.message);
            }
        }
        return {...data, roles: [{ id: 1, nombre: 'Estudiante' }] };
    }
    async update(id, data) {
        const updatePayload = {};
        if (data.username !== undefined) updatePayload.username = String(data.username).trim();
        if (data.email !== undefined) updatePayload.email = normalizeEmail(data.email);
        if (data.avatar !== undefined) updatePayload.avatar = data.avatar;
        if (data.password !== undefined) updatePayload.contrasena = data.password;
        if (data.is_active !== undefined) updatePayload.is_active = data.is_active;

        const personaInput = { ...(data.persona || {}) };
        if (data.nombres !== undefined || data.nombre !== undefined) personaInput.nombres = data.nombres ?? data.nombre;
        if (data.apellidos !== undefined || data.apellido !== undefined) personaInput.apellidos = data.apellidos ?? data.apellido;
        if (data.telefono !== undefined) personaInput.telefono = data.telefono;

        const personaPayload = {};
        if (personaInput.nombres !== undefined) personaPayload.nombres = String(personaInput.nombres ?? '').trim();
        if (personaInput.apellidos !== undefined) personaPayload.apellidos = String(personaInput.apellidos ?? '').trim();
        if (personaInput.telefono !== undefined) personaPayload.telefono = String(personaInput.telefono ?? '').trim();

        if (Object.keys(personaPayload).length > 0) {
            const { data: currentUser, error: currentError } = await this.client
                .from('usuarios')
                .select('id, username, persona_id')
                .eq('id', id)
                .maybeSingle();

            if (currentError || !currentUser) {
                throw new Error(`Error obteniendo usuario para actualizar persona: ${currentError?.message || 'usuario no encontrado'}`);
            }

            if (currentUser.persona_id) {
                const { error: personaError } = await this.client
                    .from('personas')
                    .update(personaPayload)
                    .eq('id', currentUser.persona_id);
                if (personaError) throw new Error(`Error actualizando persona: ${personaError.message}`);
            } else {
                const insertPayload = {
                    nombres: personaPayload.nombres ?? currentUser.username ?? 'Usuario',
                    apellidos: personaPayload.apellidos ?? '',
                    telefono: personaPayload.telefono ?? null,
                };
                const { data: createdPersona, error: personaError } = await this.client
                    .from('personas')
                    .insert(insertPayload)
                    .select('id')
                    .single();
                if (personaError) throw new Error(`Error creando persona: ${personaError.message}`);
                updatePayload.persona_id = createdPersona.id;
            }
        }

        if (Object.keys(updatePayload).length > 0) {
            const { error } = await this.client
                .from('usuarios')
                .update(updatePayload)
                .eq('id', id)
                .select()
                .single();
            if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
        }

        return this.findById(id);
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

        // Text-based searches (username, nombres, apellidos)
        // Email excluido: está hasheado y no permite búsqueda parcial.
        const textSearches = [
            this.client.from('usuarios').select(baseSelect).ilike('username', `%${normalizedQuery}%`).limit(textSearchLimit),
            this.client.from('usuarios').select(baseSelect).ilike('personas.nombres', `%${normalizedQuery}%`).limit(textSearchLimit),
            this.client.from('usuarios').select(baseSelect).ilike('personas.apellidos', `%${normalizedQuery}%`).limit(textSearchLimit),
        ];

        // Si la consulta tiene dígitos, hashear la cédula y buscar por hash exacto.
        // La cédula está hasheada en DB — solo es posible búsqueda exacta.
        const identificationPromise = digitsOnly
            ? (async () => {
                const cedulaHash = hashCedula(digitsOnly);
                if (!cedulaHash) return { data: [] };
                const { data: matchedPersonas } = await this.client
                    .from('personas').select('*').eq('identificacion_original', cedulaHash).limit(safeLimit);
                if (!matchedPersonas?.length) return { data: [] };
                const personaById = new Map(matchedPersonas.map(p => [p.id, p]));
                const personaIds = matchedPersonas.map(p => p.id);
                const { data: usersRaw } = await this.client
                    .from('usuarios')
                    .select('id, username, email, avatar, persona_id')
                    .in('persona_id', personaIds)
                    .limit(safeLimit);
                if (!usersRaw?.length) return { data: [] };
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
            const fullName = this._normalizeSearchText(`${persona?.nombres || ''} ${persona?.apellidos || ''}`);
            // Email e identificacion están hasheados — solo se compara username y nombre completo.
            return username.includes(normalizedQuery) || fullName.includes(normalizedQuery);
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
