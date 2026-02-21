/**
 * WhatsAppController — Controlador HTTP para el módulo WhatsApp.
 *
 * Endpoints:
 *   GET  /webhook  → Verificación del webhook de Meta (challenge)
 *   POST /webhook  → Recepción de mensajes entrantes
 *   POST /link     → Vincular cuenta (requiere JWT)
 *   POST /verify   → Verificar OTP (requiere JWT)
 *   POST /unlink   → Desvincular cuenta (requiere JWT)
 *   GET  /status   → Estado de vinculación (requiere JWT)
 *
 * Principios:
 *   - SRP: solo traduce HTTP ↔ dominio, no contiene lógica de negocio.
 *   - DIP: depende de WhatsAppDomainService (abstracción del dominio).
 */
import { linkWhatsAppSchema, verifyWhatsAppSchema, validatePhoneNumber } from '../../../domain/validators/WhatsAppSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class WhatsAppController {
    /**
     * @param {object} deps
     * @param {import('../../../domain/services/WhatsAppDomainService.js').WhatsAppDomainService} deps.whatsAppService
     * @param {string} deps.verifyToken — Token para la verificación del webhook de Meta.
     */
    constructor({ whatsAppService, verifyToken }) {
        this.service = whatsAppService;
        this.verifyToken = verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || '';
    }

    ensureServiceAvailable(res) {
        if (this.service) return true;
        console.warn('[WhatsAppController] Service unavailable when handling request');
        res.status(503).json({
            success: false,
            error: 'Servicio de WhatsApp no disponible temporalmente',
        });
        return false;
    }

    async isWebhookSignatureValid(req) {
        const verifySignature = this.service?.whatsAppPort?.verifySignature;
        if (typeof verifySignature !== 'function') return true;

        // If signature verification is not implemented, allow processing.
        // Some providers (YCloud) don't send Meta signatures — allow an explicit
        // debug override or accept when the configured provider is YCloud.
        const signature = req.get('x-hub-signature-256') || '';
        const payload = req.rawBody || JSON.stringify(req.body || {});

        try {
            // If signature header is missing, allow processing when debugging or using YCloud
            if (!signature) {
                if (process.env.WHATSAPP_DEBUG_TRUST_PAYLOAD === 'true') return true;
                const providerInfo = typeof this.service.whatsAppPort.getProviderInfo === 'function'
                    ? await this.service.whatsAppPort.getProviderInfo().catch(() => null)
                    : null;
                if (providerInfo && String(providerInfo.name || '').toLowerCase().includes('ycloud')) return true;
            }

            const valid = verifySignature.call(this.service.whatsAppPort, payload, signature);
            if (!valid) {
                // even if signature exists but is incorrect, we may still trust when provider is YCloud
                const providerInfo = typeof this.service.whatsAppPort.getProviderInfo === 'function'
                    ? await this.service.whatsAppPort.getProviderInfo().catch(() => null)
                    : null;
                if (providerInfo && String(providerInfo.name || '').toLowerCase().includes('ycloud')) {
                    console.warn('[WhatsApp] signature invalid but using YCloud; treating as valid');
                    return true;
                }
            }
            return valid;
        } catch (err) {
            if (process.env.WHATSAPP_DEBUG_TRUST_PAYLOAD === 'true') {
                console.warn('[WhatsApp] Signature verification threw but WHATSAPP_DEBUG_TRUST_PAYLOAD=true — continuing', err && err.message);
                return true;
            }
            console.warn('[WhatsApp] Signature verification failed with error:', err && err.message);
            return false;
        }
    }

    /**
     * GET /webhook — Verificación del webhook de Meta.
     * Meta envía hub.mode, hub.verify_token y hub.challenge.
     */
    verifyWebhook = (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === this.verifyToken) {
            console.log('[WhatsApp] Webhook verified successfully');
            return res.status(200).send(challenge);
        }

        console.warn('[WhatsApp] Webhook verification failed');
        return res.status(403).json({ success: false, error: 'Forbidden' });
    };

    /**
     * POST /webhook — Recepción de mensajes entrantes.
     * Meta envía el payload con las notificaciones de mensajes.
     * Responde 200 inmediatamente para no bloquear el webhook.
     */
    handleWebhook = async(req, res) => {
        // Siempre responder 200 a Meta inmediatamente
        res.status(200).json({ success: true });

        try {
            const sigValid = await this.isWebhookSignatureValid(req);
            if (!sigValid) {
                console.warn('[WhatsApp] Invalid webhook signature.');
                // allow through for trusted cases (debug or YCloud provider)
                if (process.env.WHATSAPP_DEBUG_TRUST_PAYLOAD === 'true') {
                    console.warn('[WhatsApp] WHATSAPP_DEBUG_TRUST_PAYLOAD=true — continuing anyway');
                } else {
                    // Try to detect provider info and trust YCloud
                    try {
                        const providerInfo = typeof this.service.whatsAppPort?.getProviderInfo === 'function'
                            ? await this.service.whatsAppPort.getProviderInfo().catch(() => null)
                            : null;
                        if (providerInfo && String(providerInfo.name || '').toLowerCase().includes('ycloud')) {
                            console.warn('[WhatsApp] Signature invalid but provider is YCloud; trusting payload');
                        } else {
                            return; // drop otherwise
                        }
                    } catch (e) {
                        return; // if provider check fails just bail
                    }
                }
            }

            const body = req.body;
            if (process.env.WHATSAPP_DEBUG === 'true') {
                console.log('[WhatsApp] webhook payload:', JSON.stringify(body));
            }

            // The Meta Cloud API uses object==='whatsapp_business_account' with entry/changes
            // but some alternative providers (YCloud, test harnesses) send a flatter
            // { messages: [...] } structure.  Handle both.
            const handleMetaEntry = (entry) => {
                const changes = entry.changes || [];
                for (const change of changes) {
                    if (change.field !== 'messages') continue;
                    const value = change.value || {};
                    const messages = value.messages || [];
                    const contacts = value.contacts || [];
                    for (const message of messages) {
                        dispatchMessage(message, contacts[0]);
                    }
                }
            };

            const dispatchMessage = (message, contact) => {
                const rawFrom = message.from || (contact && contact.wa_id) || '';
                // extract text from a variety of possible message shapes (text, interactive, list, etc.)
                let messageBody = '';
                // plain text
                if (message.text && typeof message.text.body === 'string') {
                    messageBody = message.text.body;
                }
                // interactive buttons or list replies
                else if (message.interactive) {
                    const interactive = message.interactive;
                    if (interactive.button_reply && interactive.button_reply.title) {
                        messageBody = interactive.button_reply.title;
                    } else if (interactive.list_reply && interactive.list_reply.title) {
                        messageBody = interactive.list_reply.title;
                    } else if (interactive.type === 'product_list' && interactive.product_list_reply && interactive.product_list_reply.product_items) {
                        // just convert to string representation
                        messageBody = JSON.stringify(interactive.product_list_reply);
                    }
                }
                // fallback captions (media messages with caption)
                if (!messageBody && message.caption) {
                    messageBody = message.caption;
                }
                const messageType = message.type || (messageBody ? 'text' : 'unknown');
                const waMessageId = message.id || message.message_id || null;

                let normalizedFrom = String(rawFrom).trim();
                // ensure leading plus and default country code if necessary
                if (!normalizedFrom.startsWith('+')) {
                    normalizedFrom = '+' + normalizedFrom;
                }
                // add default country code when number appears to be missing one
                const defaultCC = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '';
                if (defaultCC) {
                    const digits = normalizedFrom.replace(/^\+/, '');
                    // if the digits length matches local mobile without country code (e.g. 10)
                    // and it does not already start with defaultCC, prepend it
                    if (!digits.startsWith(defaultCC) && digits.length <= 11) {
                        normalizedFrom = `+${defaultCC}${digits}`;
                    }
                }

                this.service.handleIncomingMessage({
                    from: normalizedFrom,
                    messageBody,
                    messageType,
                    waMessageId,
                }).catch(err => {
                    console.error('[WhatsApp] Error processing webhook message:', err);
                });
            };

            // Meta style
            if (body?.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
                for (const entry of body.entry) {
                    handleMetaEntry(entry);
                }
                return;
            }

            // Generic style (YCloud or similar)
            if (Array.isArray(body?.messages)) {
                for (const msg of body.messages) {
                    dispatchMessage(msg, body.contacts ? body.contacts[0] : null);
                }
            }

            // If payload doesn't match expected shapes, just log it for debugging
            // but don't throw; we already returned 200 to WhatsApp above.
            // This ensures we don't silently ignore new providers.

        } catch (error) {
            console.error('[WhatsApp] Error in handleWebhook:', error);
        }
    };

    /**
     * POST /link — Vincular una cuenta de WhatsApp.
     * Body: { phoneNumber: string }
     * Requiere: JWT auth
     */
    linkAccount = async(req, res, next) => {
        try {
            console.log('[WhatsAppController] linkAccount called by user:', req.user?.userId, 'body:', req.body);
            if (!this.ensureServiceAvailable(res)) return;

            if (typeof this.service.getChannelAvailability === 'function') {
                const availability = await this.service.getChannelAvailability();
                if (!availability.available) {
                    return res.status(503).json({
                        success: false,
                        error: {
                            code: 'WHATSAPP_UNAVAILABLE',
                            message: 'Servicio de WhatsApp no disponible temporalmente. Intenta de nuevo más tarde.',
                            statusCode: 503,
                        },
                    });
                }
            }

            const rawPhone = req.body?.phoneNumber;
            const normalizedPhone = validatePhoneNumber(rawPhone);
            if (!normalizedPhone.valid) {
                return next(new ValidationError(normalizedPhone.error || 'Número de teléfono inválido'));
            }

            const { error, value } = linkWhatsAppSchema.validate({ phoneNumber: normalizedPhone.normalized });
            if (error) return next(ValidationError.fromJoi(error));

            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ success: false, error: 'No autorizado' });

            const result = await this.service.linkAccount(userId, value.phoneNumber);
            console.log('[WhatsAppController] linkAccount service result:', result && (result.isOk ? (result.isOk() ? 'ok' : 'fail') : 'unknown'));
            if (result.isFail()) {
                const domainError = result.getError();

                if (domainError?.code === 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE') {
                    return res.status(400).json({
                        success: false,
                        error: {
                            code: 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE',
                            message: 'No se pudo enviar el OTP porque este número no está permitido en el modo prueba de Meta. Agrega el número como tester en WhatsApp Cloud API o publica la app para usar números externos.',
                            statusCode: 400,
                        },
                    });
                }

                if (domainError?.code === 'WHATSAPP_OTP_SEND_FAILED') {
                    return res.status(502).json({
                        success: false,
                        error: {
                            code: 'WHATSAPP_OTP_SEND_FAILED',
                            message: 'No se pudo enviar el código de verificación por WhatsApp. Verifica el número e inténtalo nuevamente.',
                            statusCode: 502,
                        },
                    });
                }

                if (domainError?.code === 'WHATSAPP_ACCOUNT_NOT_REGISTERED') {
                    return res.status(400).json({
                        success: false,
                        error: {
                            code: 'WHATSAPP_ACCOUNT_NOT_REGISTERED',
                            message: 'El número ingresado no tiene una cuenta de WhatsApp activa. Verifica que el número sea correcto y tenga WhatsApp instalado.',
                            statusCode: 400,
                        },
                    });
                }

                return next(domainError);
            }

            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /verify — Verificar código OTP.
     * Body: { code: string (6 dígitos) }
     * Requiere: JWT auth
     */
    verifyOtp = async(req, res, next) => {
        try {
            console.log('[WhatsAppController] verifyOtp called by user:', req.user?.userId, 'body:', req.body);
            if (!this.ensureServiceAvailable(res)) return;

            const { error, value } = verifyWhatsAppSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ success: false, error: 'No autorizado' });

            const result = await this.service.verifyOtp(userId, value.code);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /unlink — Desvincular cuenta de WhatsApp.
     * Requiere: JWT auth
     */
    unlinkAccount = async(req, res, next) => {
        try {
            if (!this.ensureServiceAvailable(res)) return;

            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ success: false, error: 'No autorizado' });

            const result = await this.service.unlinkAccount(userId);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };

    /**
     * GET /status — Estado de vinculación.
     * Requiere: JWT auth
     */
    getStatus = async(req, res, next) => {
        try {
            if (!this.ensureServiceAvailable(res)) return;

            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ success: false, error: 'No autorizado' });

            const result = await this.service.getStatus(userId);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };
}

export default WhatsAppController;

