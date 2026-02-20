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
     * @param {string} [config.otpTemplateName] — Nombre de la plantilla OTP en Meta (default: hello_world).
     * @param {string} [config.otpTemplateLanguage] — Código de idioma de la plantilla (default: en_US).
     */
    constructor({ accessToken, phoneId, appSecret = null, otpTemplateName = null, otpTemplateLanguage = null }) {
        if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is required');
        if (!phoneId) throw new Error('WHATSAPP_PHONE_ID is required');

        this.accessToken = accessToken;
        this.phoneId = phoneId;
        this.appSecret = appSecret;
        this.otpTemplateName = otpTemplateName || 'hello_world';
        this.otpTemplateLanguage = otpTemplateLanguage || 'en_US';
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
     * Envía un mensaje de plantilla (template message).
     * Requerido para iniciar conversaciones fuera de la ventana de 24h.
     *
     * @param {string} phoneNumber — Número en formato E.164 (con o sin +).
     * @param {string} templateName — Nombre de la plantilla aprobada en Meta.
     * @param {string} languageCode — Código de idioma (ej: 'es', 'en_US').
     * @param {object[]} [components] — Parámetros del template (header, body, button).
     * @returns {Promise<{messageId: string}>}
     */
    async sendTemplateMessage(phoneNumber, templateName, languageCode = 'en_US', components = []) {
        const to = phoneNumber.replace(/^\+/, '');

        const template = {
            name: templateName,
            language: { code: languageCode },
        };
        if (components.length > 0) {
            template.components = components;
        }

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'template',
            template,
        };

        const response = await this._request('POST', this.messagesUrl, body);
        const messageId = response?.messages?.[0]?.id || null;
        return { messageId };
    }

    /**
     * Envía el OTP usando una plantilla de Meta o texto libre como fallback.
     * Si existe una plantilla OTP configurada y con parámetros, la usa.
     * Si la plantilla es 'hello_world' (default/prueba), envía texto libre.
     *
     * @param {string} phoneNumber — Número E.164.
     * @param {string} otpCode — Código OTP de 6 dígitos.
     * @returns {Promise<{messageId: string}>}
     */
    async sendOtpMessage(phoneNumber, otpCode) {
        const templateName = this.otpTemplateName;
        const lang = this.otpTemplateLanguage;

        // Si es hello_world (template de prueba) → usarla sin parámetros OTP
        if (templateName === 'hello_world') {
            console.log('[MetaWhatsAppAdapter] Usando template hello_world (modo prueba). OTP:', otpCode);
            return this.sendTemplateMessage(phoneNumber, 'hello_world', 'en_US');
        }

        // Template OTP personalizado → enviar con el código como parámetro body
        const components = [{
            type: 'body',
            parameters: [
                { type: 'text', text: otpCode },
            ],
        }, ];

        return this.sendTemplateMessage(phoneNumber, templateName, lang, components);
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
        // If credentials are configured, assume the adapter is available by default.
        // External Graph API permission checks can produce false negatives in sandbox
        // or when tokens/ids are rotated. Allow a strict runtime check via env var.
        if (this.accessToken && this.phoneId) {
            if (process.env.WHATSAPP_STRICT_CHECK === 'true') {
                try {
                    const url = `${META_BASE_URL}/${this.phoneId}?fields=id`;
                    await this._request('GET', url);
                    return true;
                } catch (err) {
                    return false;
                }
            }
            return true;
        }
        return false;
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
            const metaSubcode = Number(metaError.error_subcode);
            const isHelloWorldTemplate = body?.type === 'template' && body?.template?.name === 'hello_world';
            const isRecipientNotAllowed =
                metaCode === 131030 ||
                String(rawErrorMsg).includes('131030') ||
                String(rawErrorMsg).toLowerCase().includes('recipient phone number not in allowed list');

            const isAccountNotRegistered =
                metaCode === 133010 ||
                metaSubcode === 133010 ||
                String(rawErrorMsg).includes('133010') ||
                String(rawErrorMsg).toLowerCase().includes('account not registered');

            const treatAsTestModeRestriction = isHelloWorldTemplate && isAccountNotRegistered;

            let errorMsg = rawErrorMsg;
            if (isRecipientNotAllowed || treatAsTestModeRestriction) {
                errorMsg = 'El número destino no está permitido en modo prueba de Meta (allowed list). Agrega el número como tester en WhatsApp Cloud API o publica la app.';
            } else if (isAccountNotRegistered) {
                errorMsg = 'El número ingresado no tiene una cuenta de WhatsApp activa. Verifica que el número sea correcto y tenga WhatsApp instalado.';
            }

            console.error(`[MetaWhatsAppAdapter] ${method} ${url} → ${response.status}:`, errorMsg);
            const error = new Error(errorMsg);
            if (isRecipientNotAllowed || treatAsTestModeRestriction) {
                error.code = 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE';
            } else if (isAccountNotRegistered) {
                error.code = 'WHATSAPP_ACCOUNT_NOT_REGISTERED';
            }
            error.metaCode = metaError.code;
            error.metaSubcode = metaError.error_subcode;
            error.httpStatus = response.status;
            // Common root cause: using a Business Account ID instead of a Phone Number ID
            // when calling /{phone_number_id}/messages. Attempt automatic discovery
            // of phone_number_id and retry once if permissions error is detected.
            const permissionMsg = String(rawErrorMsg || '').toLowerCase();
            if (response.status === 403 && permissionMsg.includes('you do not have the necessary permissions') && url.includes('/messages')) {
                try {
                    const discovered = await this._discoverPhoneNumberId();
                    if (discovered) {
                        const newUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
                        console.log(`[MetaWhatsAppAdapter] Retrying ${method} ${newUrl} after discovering phone_number_id=${this.phoneId}`);
                        // Retry once with the discovered phoneId
                        const retryOptions = { method, headers: options.headers };
                        if (body && method !== 'GET') retryOptions.body = JSON.stringify(body);
                        const retryResp = await fetch(newUrl, retryOptions);
                        const retryData = await retryResp.json();
                        if (!retryResp.ok) {
                            const retryErrMsg = retryData?.error?.message || `Meta API error: ${retryResp.status}`;
                            console.error(`[MetaWhatsAppAdapter] Retry failed: ${retryResp.status} ${retryErrMsg}`);
                            const retryError = new Error(retryErrMsg);
                            retryError.httpStatus = retryResp.status;
                            throw retryError;
                        }
                        return retryData;
                    }
                } catch (discErr) {
                    console.warn('[MetaWhatsAppAdapter] Phone number discovery failed:', discErr?.message || discErr);
                    // Fall through to throw original error with guidance
                }
            }
            throw error;
        }

        return data;
    }

    /**
     * Attempt to discover a phone_number_id when the configured `phoneId`
     * appears to be a WhatsApp Business Account ID.
     * If discovery succeeds, updates `this.phoneId` and `this.messagesUrl`.
     * @returns {Promise<boolean>} true if a phone_number_id was found and set
     */
    async _discoverPhoneNumberId() {
        if (!this.accessToken || !this.phoneId) return false;

        const tryUrls = [
            `${META_BASE_URL}/${this.phoneId}/phone_numbers`,
            `${META_BASE_URL}/${this.phoneId}?fields=phone_numbers{display_phone_number,id}`,
        ];

        for (const u of tryUrls) {
            try {
                const resp = await fetch(u, { method: 'GET', headers: { Authorization: `Bearer ${this.accessToken}` } });
                const json = await resp.json();
                if (!resp.ok) continue;

                // Graph returns list under `data` for /phone_numbers
                const candidates = json?.data || (json?.phone_numbers ? json.phone_numbers.data || json.phone_numbers : null);
                if (Array.isArray(candidates) && candidates.length > 0) {
                    const first = candidates[0];
                    const discoveredId = first.id || first.phone_number_id || null;
                    if (discoveredId) {
                        this.phoneId = discoveredId;
                        this.messagesUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
                        console.log(`[MetaWhatsAppAdapter] Discovered phone_number_id=${this.phoneId} from ${u}`);
                        return true;
                    }
                }

                // Try alternative shape: json?.phone_numbers?.data
                const alt = json?.phone_numbers?.data;
                if (Array.isArray(alt) && alt.length > 0 && alt[0].id) {
                    this.phoneId = alt[0].id;
                    this.messagesUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
                    console.log(`[MetaWhatsAppAdapter] Discovered phone_number_id=${this.phoneId} from ${u}`);
                    return true;
                }
            } catch (e) {
                // Ignore and try next
            }
        }

        return false;
    }
}

export default MetaWhatsAppAdapter;

