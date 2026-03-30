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

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// Reutilizar el cliente para beneficiarse del caché de claves públicas
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Verifica criptográficamente un Google ID Token y retorna su payload.
 *
 * @param {string} idToken - El credential JWT emitido por Google.
 * @returns {Promise<{email: string, name?: string, picture?: string, sub: string}>}
 * @throws {ValidationError} Si el token es inválido, expirado o la firma no es correcta.
 */
export async function verifyGoogleIdToken(idToken) {
    if (!GOOGLE_CLIENT_ID) {
        throw new Error('GOOGLE_CLIENT_ID no está configurado en las variables de entorno');
    }

    try {
        const ticket = await oauthClient.verifyIdToken({
            idToken,
            audience: GOOGLE_CLIENT_ID,
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
