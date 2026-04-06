/**
 * public-register.routes.js
 *
 * POST /api/v1/register
 *
 * Crea una persona + usuario en el tenant identificado por el
 * Supabase anon key enviado como Bearer token.
 *
 * Autenticación: Authorization: Bearer <supabase_anon_key>
 *   - El payload del JWT (sin verificar firma) debe contener `ref`
 *     que coincida con uno de los proyectos de TENANT_CONFIGS.
 *   - El claim `role` debe ser "anon" (distingue del service_role key).
 *
 * Seguridad de datos: sigue las mismas convenciones de hashing que
 * los repositorios existentes (SHA-256 para email, telefono, direccion,
 * identificacion_original; bcrypt-10 para la contraseña).
 */
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { TENANT_CONFIGS, getTenantClient } from '../../config/tenantRegistry.js';

// ─── Helpers de hashing (mismo patrón que los repositorios) ────────────────

function sha256(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!str) return null;
    return crypto.createHash('sha256').update(str).digest('hex');
}

function hashEmail(email) {
    if (!email) return null;
    return sha256(String(email).trim().toLowerCase());
}

function hashCedula(rawCedula) {
    if (!rawCedula) return null;
    const digits = String(rawCedula).replace(/\D/g, '').trim();
    if (!digits) return null;
    return sha256(digits);
}

// ─── Resolución de tenant a partir del anon key ────────────────────────────
/**
 * Decodifica el payload de un JWT sin verificar la firma.
 * Retorna null si el token está malformado.
 */
function decodeJwtPayload(token) {
    try {
        const parts = token.split('.');
        if (parts.length < 2) return null;
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * Extrae el project ref del supabaseUrl de un tenant config.
 * Formato esperado: https://<ref>.supabase.co
 */
function extractRefFromUrl(supabaseUrl) {
    if (!supabaseUrl) return null;
    const match = /https:\/\/([^.]+)\.supabase\.co/.exec(supabaseUrl);
    return match ? match[1] : null;
}

/**
 * Resuelve el cliente Supabase (service key) a partir de un anon key.
 * Valida que:
 *   - El JWT tenga claim `role === 'anon'`
 *   - El claim `ref` coincida con un tenant registrado en TENANT_CONFIGS
 *
 * Retorna { client, tenantId } o null si no es válido.
 */
function resolveTenantFromAnonKey(token) {
    const payload = decodeJwtPayload(token);
    if (!payload) return null;

    // Must be the anon key (not service_role or a user JWT)
    if (payload.role !== 'anon') return null;

    const ref = payload.ref;
    if (!ref) return null;

    const tenant = TENANT_CONFIGS.find(t => extractRefFromUrl(t.supabaseUrl) === ref);
    if (!tenant) return null;

    return { client: getTenantClient(tenant.id), tenantId: tenant.id };
}

// ─── Route factory ──────────────────────────────────────────────────────────

export function publicRegisterRoutes() {
    const router = Router();

    router.post('/', async(req, res) => {
        // 1. Validar anon key en el header Authorization
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Se requiere Authorization: Bearer <supabase_anon_key>' });
        }

        const token = authHeader.slice(7);
        const resolved = resolveTenantFromAnonKey(token);
        if (!resolved) {
            return res.status(401).json({ error: 'Anon key inválida o proyecto no registrado' });
        }

        const { client } = resolved;

        // 2. Extraer y validar campos del body
        const {
            nombres,
            apellidos,
            identificacion,
            telefono,
            fecha_nacimiento,
            institucion_id,
            direccion,
            username,
            email,
            contrasena,
            avatar,
            rol_id,
            asignado_en,
            is_active,
        } = req.body || {};

        if (!nombres || typeof nombres !== 'string' || !nombres.trim()) {
            return res.status(400).json({ error: 'El campo "nombres" es requerido' });
        }
        if (!username || typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'El campo "username" es requerido' });
        }
        if (!email || typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({ error: 'El campo "email" es requerido' });
        }
        if (!contrasena || typeof contrasena !== 'string' || contrasena.length < 1) {
            return res.status(400).json({ error: 'El campo "contrasena" es requerido' });
        }

        // Validación básica de formato de email
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return res.status(400).json({ error: 'Formato de email inválido' });
        }

        let personaId = null;

        try {
            // 3. Hashear contraseña con bcrypt (cost 10)
            const hashedPassword = await bcrypt.hash(contrasena, 10);

            // 4. Preparar e insertar en "personas"
            const cedulaDigits = identificacion ?
                String(identificacion).replace(/\D/g, '').trim() :
                null;
            const numericCedula = cedulaDigits ? Number(cedulaDigits) : null;

            const personaPayload = {
                nombres: nombres.trim(),
                apellidos: apellidos ? String(apellidos).trim() : '',
                identificacion: Number.isFinite(numericCedula) ? numericCedula : null,
                identificacion_original: hashCedula(cedulaDigits),
                telefono: telefono ? sha256(String(telefono).trim()) : '',
                direccion: direccion ? sha256(String(direccion).trim()) : '',
                fecha_nacimiento: fecha_nacimiento || null,
            };

            if (institucion_id != null) {
                personaPayload.institucion_id = Number(institucion_id);
            }

            const { data: persona, error: personaError } = await client
                .from('personas')
                .insert(personaPayload)
                .select('id')
                .single();

            if (personaError) {
                // Persona uniqueness violations (identificacion_original)
                if (personaError.code === '23505') {
                    return res.status(409).json({ error: 'Ya existe una persona con esa identificación' });
                }
                return res.status(500).json({ error: `Error creando persona: ${personaError.message}` });
            }

            personaId = persona.id;

            // 5. Insertar en "usuarios"
            const usuarioPayload = {
                username: username.trim(),
                email: hashEmail(email),
                contrasena: hashedPassword,
                persona_id: personaId,
            };

            if (avatar != null) usuarioPayload.avatar = avatar;
            if (is_active != null) usuarioPayload.is_active = Boolean(is_active);

            const { data: usuario, error: usuarioError } = await client
                .from('usuarios')
                .insert(usuarioPayload)
                .select('id')
                .single();

            if (usuarioError) {
                // Rollback: eliminar persona recién creada
                await client.from('personas').delete().eq('id', personaId).catch(() => {});

                if (
                    usuarioError.code === '23505' ||
                    (usuarioError.message || '').toLowerCase().includes('duplicate') ||
                    (usuarioError.message || '').toLowerCase().includes('unique')
                ) {
                    return res.status(409).json({ error: 'Ya existe un usuario con ese email/username' });
                }

                return res.status(500).json({ error: `Error creando usuario: ${usuarioError.message}` });
            }

            const usuarioId = usuario.id;

            // 6. Asignar rol (por defecto rol 1 si no se especifica)
            const roleId = Number(rol_id) > 0 ? Number(rol_id) : 1;
            const rolPayload = { usuario_id: usuarioId, rol_id: roleId };
            if (asignado_en != null) rolPayload.asignado_en = asignado_en;

            await client
                .from('usuarios_roles')
                .upsert(rolPayload, { onConflict: 'usuario_id,rol_id' })
                .catch(() => {});

            // 7. Respuesta 201
            return res.status(201).json({
                success: true,
                persona_id: personaId,
                usuario_id: usuarioId,
            });
        } catch (err) {
            // Defensive rollback
            if (personaId) {
                await client.from('personas').delete().eq('id', personaId).catch(() => {});
            }
            return res.status(500).json({ error: err.message || 'Error interno del servidor' });
        }
    });

    return router;
}

export default publicRegisterRoutes;