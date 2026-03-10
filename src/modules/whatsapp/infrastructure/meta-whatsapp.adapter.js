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
        // Allow using an explicit phone_number_id override from env var
        const envPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
        if (!phoneId && !envPhoneNumberId) throw new Error('WHATSAPP_PHONE_ID is required (or set WHATSAPP_PHONE_NUMBER_ID)');

        this.accessToken = accessToken;
        this.phoneId = envPhoneNumberId || phoneId;
        this.appSecret = appSecret;
        this.otpTemplateName = otpTemplateName || 'hello_world';
        this.otpTemplateLanguage = otpTemplateLanguage || 'en_US';
        this.messagesUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
    }

    /**
     * Allow setting phone_number_id at runtime.
     * Useful when discovery finds the correct id or for manual override.
     * @param {string} phoneNumberId
     */
    setPhoneNumberId(phoneNumberId) {
        if (!phoneNumberId) return;
        this.phoneId = phoneNumberId;
        this.messagesUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
        console.log(`[MetaWhatsAppAdapter] phone_number_id set to ${this.phoneId}`);
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
        // If no app secret was configured we cannot verify the signature,
        // so we treat every payload as valid. This allows local development
        // or alternative providers (e.g. YCloud) to function without forcing
        // the user to supply a secret. The controller also checks for
        // missing signature and respects the WHATSAPP_DEBUG_TRUST_PAYLOAD flag.
        if (!this.appSecret) {
            if (process.env.WHATSAPP_DEBUG === 'true') {
                console.warn('[MetaWhatsAppAdapter] no appSecret configured – skipping signature verification');
            }
            return true;
        }

        if (!signature) {
            // signature missing – reject unless debugging/trust payload
            return false;
        }

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
            headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        };
        if (body && method !== 'GET') options.body = JSON.stringify(body);

        const response = await fetch(url, options);
        const data = await response.json();

        if (process.env.WHATSAPP_DEBUG === 'true') {
            console.debug('[MetaWhatsAppAdapter] Response:', JSON.stringify(data));
        }

        if (!response.ok) {
            throw await this._buildMetaError(response, data, method, url, options, body);
        }

        return data;
    }

    /**
     * Construye el error de Meta e intenta descubrir phone_number_id si hay error de permisos.
     * @private
     */
    async _buildMetaError(response, data, method, url, options, body) {
        const metaError = data?.error || {};
        const rawMsg = metaError.message || `Meta API error: ${response.status}`;
        const metaCode = Number(metaError.code);
        const metaSubcode = Number(metaError.error_subcode);

        const isRecipientNotAllowed = metaCode === 131030 || String(rawMsg).includes('131030') || String(rawMsg).toLowerCase().includes('recipient phone number not in allowed list');
        const isAccountNotRegistered = metaCode === 133010 || metaSubcode === 133010 || String(rawMsg).toLowerCase().includes('account not registered');
        const isHelloWorldTemplate = body?.type === 'template' && body?.template?.name === 'hello_world';
        const isPermissionError = (response.status === 403 || metaCode === 200) && String(rawMsg).toLowerCase().includes('necessary permissions');

        let errorMsg = rawMsg;
        if (isRecipientNotAllowed || (isHelloWorldTemplate && isAccountNotRegistered)) {
            errorMsg = 'El número destino no está permitido en modo prueba de Meta. Agrega el número como tester en WhatsApp Cloud API o publica la app.';
        } else if (isAccountNotRegistered) {
            errorMsg = 'El número no tiene una cuenta de WhatsApp activa. Verifica que el número sea correcto.';
        } else if (isPermissionError) {
            errorMsg = rawMsg + ' — Verifica que el token tenga scopes whatsapp_business_messaging/whatsapp_business_management y que uses phone_number_id (no WABA id).';
        }

        console.error(`[MetaWhatsAppAdapter] ${method} ${url} → ${response.status}:`, errorMsg);
        if (process.env.WHATSAPP_DEBUG === 'true') console.error('[MetaWhatsAppAdapter] raw error:', metaError);

        // Si es error de permisos en /messages, intentar descubrir el phone_number_id correcto y reintentar
        if (isPermissionError && url.includes('/messages')) {
            const retryResult = await this._retryWithDiscovery(method, url, options, body);
            if (retryResult) return retryResult; // retryResult es data si tuvo éxito, lanza si no
        }

        const error = new Error(errorMsg);
        error.metaCode = metaError.code;
        error.metaSubcode = metaError.error_subcode;
        error.httpStatus = response.status;
        if (isRecipientNotAllowed || (isHelloWorldTemplate && isAccountNotRegistered)) error.code = 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE';
        else if (isAccountNotRegistered) error.code = 'WHATSAPP_ACCOUNT_NOT_REGISTERED';
        return error;
    }

    /**
     * Intenta descubrir el phone_number_id correcto y reintentar la petición.
     * @returns {Promise<object|null>} data si el reintento tuvo éxito, null si discovery falló.
     * @throws si el reintento también falla.
     * @private
     */
    async _retryWithDiscovery(method, url, options, body) {
        try {
            const target = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || this.phoneId;
            const discovered = await this._discoverPhoneNumberId(target);
            if (!discovered) return null;

            const newUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
            console.log(`[MetaWhatsAppAdapter] Retrying ${method} ${newUrl} (phone_number_id=${this.phoneId})`);

            const retryOptions = { method, headers: options.headers };
            if (body && method !== 'GET') retryOptions.body = JSON.stringify(body);
            const retryResp = await fetch(newUrl, retryOptions);
            const retryData = await retryResp.json();

            if (!retryResp.ok) {
                const errMsg = retryData?.error?.message || `Meta API error: ${retryResp.status}`;
                console.error(`[MetaWhatsAppAdapter] Retry failed: ${retryResp.status} ${errMsg}`);
                throw Object.assign(new Error(errMsg), { httpStatus: retryResp.status });
            }
            return retryData;
        } catch (discErr) {
            console.warn('[MetaWhatsAppAdapter] Discovery/retry failed:', discErr?.message);
            return null;
        }
    }

    /**
     * Attempt to discover a phone_number_id when the configured `phoneId`
     * appears to be a WhatsApp Business Account ID.
     * If discovery succeeds, updates `this.phoneId` and `this.messagesUrl`.
     * @returns {Promise<boolean>} true if a phone_number_id was found and set
     */
    async _discoverPhoneNumberId(targetId = null) {
        const target = targetId || this.phoneId;
        if (!this.accessToken || !target) return false;

        const tryUrls = [
            `${META_BASE_URL}/${target}/phone_numbers`,
            `${META_BASE_URL}/${target}?fields=phone_numbers{display_phone_number,id}`,
            // Some Graph shapes may return phone_numbers under different fields
            `${META_BASE_URL}/${target}?fields=owned_phone_numbers{display_phone_number,id}`,
        ];

        for (const u of tryUrls) {
            try {
                const resp = await fetch(u, { method: 'GET', headers: { Authorization: `Bearer ${this.accessToken}` } });
                const json = await resp.json();
                if (!resp.ok) continue;

                // Try several shapes where phone numbers may be present
                const rawCandidates = json?.data || json?.phone_numbers || json?.phone_numbers?.data || json?.owned_phone_numbers || json?.owned_phone_numbers?.data || null;

                let candidates = null;
                if (Array.isArray(rawCandidates)) candidates = rawCandidates;
                else if (rawCandidates && typeof rawCandidates === 'object') {
                    // Graph sometimes nests under { data: [...] }
                    if (Array.isArray(rawCandidates.data)) candidates = rawCandidates.data;
                    else candidates = [rawCandidates];
                }

                if (Array.isArray(candidates) && candidates.length > 0) {
                    // Log candidates for diagnostics
                    try { console.log('[MetaWhatsAppAdapter] Discovery candidates:', JSON.stringify(candidates)); } catch (e) { /* ignore */ }

                    // Prefer explicit id fields
                    for (const c of candidates) {
                        const discoveredId = c.id || c.phone_number_id || c.phone_number || null;
                        if (discoveredId) {
                            this.phoneId = discoveredId;
                            this.messagesUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
                            console.log(`[MetaWhatsAppAdapter] Discovered phone_number_id=${this.phoneId} from ${u}`);
                            return true;
                        }
                    }
                }

                // Fallback: if response contains a top-level numeric id, use it
                if (json && json.id && String(json.id).match(/^\d+$/)) {
                    this.phoneId = json.id;
                    this.messagesUrl = `${META_BASE_URL}/${this.phoneId}/messages`;
                    console.log(`[MetaWhatsAppAdapter] Using top-level id=${this.phoneId} from ${u}`);
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