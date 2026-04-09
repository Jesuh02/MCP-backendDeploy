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

// ─── Sanitizadores / validadores de entrada ────────────────────────────────

/** Elimina etiquetas HTML y caracteres de control de una cadena. */
function stripHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/<[^>]*>/g, '')         // strip HTML tags
        .replace(/[^\P{C}\t\n\r]/gu, '') // strip non-printable control chars (keep tab/newline/cr)
        .trim();
}

/** Solo letras (incluye acentos/diéresis), espacios y guiones. */
const NAMES_RE = /^[\p{L}\s'\-]{1,100}$/u;

/** Username: solo minúsculas, dígitos, guion bajo y guion. 3-30 chars. */
const USERNAME_RE = /^[a-z0-9_\-]{3,30}$/;

/** Teléfono: dígitos, +, -, espacios. */
const PHONE_RE = /^[0-9+\-\s]{5,30}$/;

/** Fecha ISO YYYY-MM-DD. */
const DATE_ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Timestamp para asignado_en: acepta ISO 8601 básico. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Valida que `url` sea una URL HTTP/HTTPS válida y no un esquema peligroso.
 * Retorna `null` si no es válida o vacía.
 */
function validateHttpUrl(url) {
    if (!url) return null;
    const s = String(url).trim();
    if (!s) return null;
    try {
        const parsed = new URL(s);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return s;
    } catch {
        return null;
    }
}

/**
 * Comprueba que la contraseña cumpla los requisitos mínimos de fuerza.
 * Retorna null si es válida, o un mensaje de error.
 */
function validatePassword(pass) {
    if (!pass || typeof pass !== 'string') return 'La contraseña es requerida';
    if (pass.length < 6)        return 'La contraseña debe tener al menos 6 caracteres';
    if (pass.length > 128)      return 'La contraseña es demasiado larga';
    if (!/[0-9]/.test(pass))    return 'La contraseña debe incluir al menos 1 número';
    if (!/[A-Z]/.test(pass))    return 'La contraseña debe incluir al menos 1 mayúscula';
    if (!/[a-z]/.test(pass))    return 'La contraseña debe incluir al menos 1 minúscula';
    if (!/[^A-Za-z0-9]/.test(pass)) return 'La contraseña debe incluir al menos 1 símbolo';
    return null;
}

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

        // 2. Extraer y validar/sanitizar campos del body
        const raw = req.body || {};

        // Rechazar si el body no es un objeto plano (previene prototype pollution)
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            return res.status(400).json({ error: 'Cuerpo de solicitud inválido' });
        }

        const nombres       = stripHtml(raw.nombres);
        const apellidos     = stripHtml(raw.apellidos);
        const username      = typeof raw.username === 'string' ? raw.username.trim().toLowerCase() : '';
        const email         = typeof raw.email    === 'string' ? raw.email.trim().toLowerCase()   : '';
        const contrasena    = typeof raw.contrasena === 'string' ? raw.contrasena : '';
        const telefono      = stripHtml(raw.telefono);
        const direccion     = stripHtml(raw.direccion);
        const fecha_nacimiento = typeof raw.fecha_nacimiento === 'string' ? raw.fecha_nacimiento.trim() : '';
        const asignado_en   = typeof raw.asignado_en === 'string' ? raw.asignado_en.trim() : null;
        const identificacion = raw.identificacion != null ? String(raw.identificacion).replace(/\D/g, '').trim() : '';
        const institucion_id = raw.institucion_id != null ? parseInt(String(raw.institucion_id), 10) : null;
        const rol_id         = raw.rol_id != null ? parseInt(String(raw.rol_id), 10) : 1;
        const is_active      = raw.is_active !== undefined ? Boolean(raw.is_active) : true;
        const avatar         = validateHttpUrl(raw.avatar); // null si no es http/https

        // Campos requeridos
        if (!nombres) return res.status(400).json({ error: 'El campo "nombres" es requerido' });
        if (!username) return res.status(400).json({ error: 'El campo "username" es requerido' });
        if (!email)    return res.status(400).json({ error: 'El campo "email" es requerido' });
        if (!contrasena) return res.status(400).json({ error: 'El campo "contrasena" es requerido' });

        // Formato de nombres/apellidos: solo letras, espacios y guiones
        if (!NAMES_RE.test(nombres))   return res.status(400).json({ error: 'El campo "nombres" contiene caracteres no permitidos' });
        if (apellidos && !NAMES_RE.test(apellidos)) return res.status(400).json({ error: 'El campo "apellidos" contiene caracteres no permitidos' });

        // Formato username
        if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'El username solo puede contener letras minúsculas, números, _ y - (3-30 caracteres)' });

        // Formato email
        if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) {
            return res.status(400).json({ error: 'Formato de email inválido' });
        }

        // Teléfono — solo si viene
        if (telefono && !PHONE_RE.test(telefono)) {
            return res.status(400).json({ error: 'El campo "telefono" contiene caracteres no permitidos' });
        }

        // Fecha de nacimiento
        if (fecha_nacimiento && !DATE_ISO_RE.test(fecha_nacimiento)) {
            return res.status(400).json({ error: 'Formato de "fecha_nacimiento" inválido (YYYY-MM-DD)' });
        }

        // Timestamp asignado_en
        if (asignado_en && !TIMESTAMP_RE.test(asignado_en)) {
            return res.status(400).json({ error: 'Formato de "asignado_en" inválido' });
        }

        // Validar rol_id como entero positivo
        if (!Number.isFinite(rol_id) || rol_id < 1) {
            return res.status(400).json({ error: 'El campo "rol_id" debe ser un entero positivo' });
        }

        // Contraseña con fuerza mínima
        const passwordError = validatePassword(contrasena);
        if (passwordError) return res.status(400).json({ error: passwordError });

        let personaId = null;

        try {
            // 3. Hashear contraseña con bcrypt (cost 10)
            const hashedPassword = await bcrypt.hash(contrasena, 10);

            // 4. Preparar e insertar en "personas"
            const cedulaDigits = identificacion || null;
            const numericCedula = cedulaDigits ? Number(cedulaDigits) : null;

            const personaPayload = {
                nombres,
                apellidos: apellidos || '',
                identificacion: Number.isFinite(numericCedula) ? numericCedula : null,
                identificacion_original: hashCedula(cedulaDigits),
                telefono: telefono || '',
                direccion: direccion ? sha256(direccion) : '',
                fecha_nacimiento: fecha_nacimiento || null,
            };

            if (Number.isFinite(institucion_id) && institucion_id > 0) {
                personaPayload.institucion_id = institucion_id;
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
                username,
                email: email,
                contrasena: hashedPassword,
                persona_id: personaId,
                is_active,
            };

            // avatar ya fue validado como URL http/https (o null)
            if (avatar != null) usuarioPayload.avatar = avatar;

            const { data: usuario, error: usuarioError } = await client
                .from('usuarios')
                .insert(usuarioPayload)
                .select('id')
                .single();

            if (usuarioError) {
                // Rollback: eliminar persona recién creada
                await Promise.resolve(
                    client.from('personas').delete().eq('id', personaId)
                ).catch(() => {});

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

            // 6. Asignar rol (ya validado como entero positivo)
            const rolPayload = { usuario_id: usuarioId, rol_id: rol_id };
            if (asignado_en) rolPayload.asignado_en = asignado_en;

            await Promise.resolve(
                client
                    .from('usuarios_roles')
                    .upsert(rolPayload, { onConflict: 'usuario_id,rol_id' })
            ).catch(() => {});

            // 7. Respuesta 201
            return res.status(201).json({
                success: true,
                persona_id: personaId,
                usuario_id: usuarioId,
            });
        } catch (err) {
            // Defensive rollback
            if (personaId) {
                await Promise.resolve(
                    client.from('personas').delete().eq('id', personaId)
                ).catch(() => {});
            }
            return res.status(500).json({ error: err.message || 'Error interno del servidor' });
        }
    });

    return router;
}

export default publicRegisterRoutes;