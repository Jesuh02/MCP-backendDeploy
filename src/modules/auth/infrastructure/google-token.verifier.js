/**
 * GoogleTokenVerifier — Adaptador de infraestructura para verificación criptográfica
 * de Google ID Tokens.
 *
 * Responsabilidades (SRP):
 *   - Verificar la firma del token contra las claves públicas de Google.
 *   - Validar audience (CLIENT_ID) y expiración.
 *   - Retornar únicamente el payload ya validado.
 *
 * La verificación se realiza con google-auth-library, que descarga las claves
 * públicas de Google y comprueba la firma JWT, el issuer y la expiración.
 *
 * Variable de entorno requerida: GOOGLE_CLIENT_ID
 */
import { OAuth2Client } from 'google-auth-library';
import { ValidationError } from '../../../shared/errors/index.js';

// Soportar múltiples Client IDs (web + Android) separados por coma
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const envIds = (GOOGLE_CLIENT_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

// IDs conocidos: siempre aceptar tokens de web y Android
const KNOWN_CLIENT_IDS = [
    '650106105156-2pc3eojksd6ino17oghdouncb25ub75h.apps.googleusercontent.com', // Web
    '311619101029-30iq38k8g9h5u8067c1vpifopep5av1h.apps.googleusercontent.com', // Android
];

// Merge: env + conocidos, sin duplicados
const GOOGLE_CLIENT_IDS = [...new Set([...envIds, ...KNOWN_CLIENT_IDS])];

// Reutilizar el cliente para beneficiarse del caché de claves públicas
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_IDS[0]);

/**
 * Verifica criptográficamente un Google ID Token y retorna su payload.
 *
 * @param {string} idToken - El credential JWT emitido por Google.
 * @returns {Promise<{email: string, name?: string, picture?: string, sub: string}>}
 * @throws {ValidationError} Si el token es inválido, expirado o la firma no es correcta.
 */
export async function verifyGoogleIdToken(idToken) {
    if (GOOGLE_CLIENT_IDS.length === 0) {
        throw new Error('GOOGLE_CLIENT_ID no está configurado en las variables de entorno');
    }

    try {
        const ticket = await oauthClient.verifyIdToken({
            idToken,
            audience: GOOGLE_CLIENT_IDS,
        });

        const payload = ticket.getPayload();

        if (!payload?.email) {
            throw new ValidationError('El token de Google no contiene un email válido');
        }

        return {
            email: payload.email,
            name: payload.name,
            given_name: payload.given_name,
            picture: payload.picture,
            sub: payload.sub,
        };
    } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError('Google credential inválida o expirada');
    }
}
