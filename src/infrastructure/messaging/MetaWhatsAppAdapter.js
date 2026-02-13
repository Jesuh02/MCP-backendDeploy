/**
 * MetaWhatsAppAdapter — Implementación de IWhatsAppPort usando la API de Meta WhatsApp Business Cloud.
 *
 * Comunica con la API REST de Meta para enviar/recibir mensajes.
 * Ref: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Principios:
 *   - SRP: solo se encarga de la comunicación HTTP con Meta.
 *   - LSP: sustituible por cualquier otro adaptador que implemente IWhatsAppPort.
 */
import crypto from 'crypto';

const META_API_VERSION = 'v22.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export class MetaWhatsAppAdapter {
    /**
     * @param {object} config
     * @param {string} config.accessToken — Token de acceso permanente (System User Token).
     * @param {string} config.phoneId — ID del número de teléfono de negocio.
     * @param {string} [config.appSecret] — App Secret para verificar firmas HMAC.
     */
    constructor({ accessToken, phoneId, appSecret = null }) {
        if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is required');
        if (!phoneId) throw new Error('WHATSAPP_PHONE_ID is required');

        this.accessToken = accessToken;
        this.phoneId = phoneId;
        this.appSecret = appSecret;
        this.messagesUrl = `${META_BASE_URL}/${phoneId}/messages`;
    }

    /**
     * Envía un mensaje de texto plano.
     * @param {string} phoneNumber — Número en formato E.164 (sin +).
     * @param {string} text — Contenido del mensaje (max 4096 chars).
     * @returns {Promise<{messageId: string}>}
     */
    async sendTextMessage(phoneNumber, text) {
        const to = phoneNumber.replace(/^\+/, '');

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: text.substring(0, 4096) },
        };

        const response = await this._request('POST', this.messagesUrl, body);
        const messageId = response?.messages?.[0]?.id || null;
        return { messageId };
    }

    /**
     * Envía un mensaje interactivo con botones.
     * @param {string} phoneNumber
     * @param {object} options — { body, buttons: [{id, title}], header?, footer? }
     * @returns {Promise<{messageId: string}>}
     */
    async sendInteractiveMessage(phoneNumber, { body, buttons = [], header = null, footer = null }) {
        const to = phoneNumber.replace(/^\+/, '');
        const interactive = {
            type: 'button',
            body: { text: body },
            action: {
                buttons: buttons.slice(0, 3).map(btn => ({
                    type: 'reply',
                    reply: { id: btn.id, title: btn.title.substring(0, 20) },
                })),
            },
        };

        if (header) interactive.header = { type: 'text', text: header };
        if (footer) interactive.footer = { text: footer };

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive,
        };

        const response = await this._request('POST', this.messagesUrl, payload);
        const messageId = response?.messages?.[0]?.id || null;
        return { messageId };
    }

    /**
     * Marca un mensaje como leído.
     * @param {string} waMessageId
     * @returns {Promise<void>}
     */
    async markAsRead(waMessageId) {
        await this._request('POST', this.messagesUrl, {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: waMessageId,
        });
    }

    /**
     * Verifica la disponibilidad del servicio.
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            const url = `${META_BASE_URL}/${this.phoneId}`;
            await this._request('GET', url);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Verifica la firma HMAC SHA256 del payload del webhook.
     * @param {string|Buffer} payload — Body raw del request.
     * @param {string} signature — Valor del header X-Hub-Signature-256.
     * @returns {boolean}
     */
    verifySignature(payload, signature) {
        if (!this.appSecret || !signature) return false;

        const expected = 'sha256=' + crypto
            .createHmac('sha256', this.appSecret)
            .update(payload)
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(expected),
            Buffer.from(signature),
        );
    }

    // ═══════════════════════════════════════════════════════════
    // HTTP interno
    // ═══════════════════════════════════════════════════════════

    /**
     * Realiza una petición HTTP a la API de Meta.
     * @param {string} method
     * @param {string} url
     * @param {object} [body]
     * @returns {Promise<object>}
     */
    async _request(method, url, body = null) {
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
            },
        };

        if (body && method !== 'GET') {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        const data = await response.json();

        if (!response.ok) {
            const metaError = data?.error || {};
            const rawErrorMsg = metaError.message || `Meta API error: ${response.status}`;
            const metaCode = Number(metaError.code);
            const isRecipientNotAllowed =
                metaCode === 131030 ||
                String(rawErrorMsg).includes('131030') ||
                String(rawErrorMsg).toLowerCase().includes('recipient phone number not in allowed list');

            const errorMsg = isRecipientNotAllowed
                ? 'El número destino no está permitido en modo prueba de Meta (allowed list). Agrega el número como tester en WhatsApp Cloud API o publica la app.'
                : rawErrorMsg;

            console.error(`[MetaWhatsAppAdapter] ${method} ${url} → ${response.status}:`, errorMsg);
            const error = new Error(errorMsg);
            if (isRecipientNotAllowed) {
                error.code = 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE';
            }
            error.metaCode = metaError.code;
            error.metaSubcode = metaError.error_subcode;
            error.httpStatus = response.status;
            throw error;
        }

        return data;
    }
}

export default MetaWhatsAppAdapter;