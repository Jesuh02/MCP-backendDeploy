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
import { linkWhatsAppSchema, verifyWhatsAppSchema } from '../../../domain/validators/WhatsAppSchemas.js';
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
        res.status(503).json({
            success: false,
            error: 'Servicio de WhatsApp no disponible temporalmente',
        });
        return false;
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
            const body = req.body;

            // Validar estructura del payload de Meta
            if (!body?.object || body.object !== 'whatsapp_business_account') return;

            const entries = body.entry || [];
            for (const entry of entries) {
                const changes = entry.changes || [];
                for (const change of changes) {
                    if (change.field !== 'messages') continue;

                    const value = change.value || {};
                    const messages = value.messages || [];
                    const contacts = value.contacts || [];

                    for (const message of messages) {
                        const from = message.from; // Número del remitente
                        const messageBody = message.text?.body || '';
                        const messageType = message.type || 'text';
                        const waMessageId = message.id;

                        // Procesar en background (no bloquear respuesta al webhook)
                        this.service.handleIncomingMessage({
                            from: `+${from}`,
                            messageBody,
                            messageType,
                            waMessageId,
                        }).catch(err => {
                            console.error('[WhatsApp] Error processing webhook message:', err);
                        });
                    }
                }
            }
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
            if (!this.ensureServiceAvailable(res)) return;

            const { error, value } = linkWhatsAppSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ success: false, error: 'No autorizado' });

            const result = await this.service.linkAccount(userId, value.phoneNumber);
            if (result.isFail()) return next(result.getError());

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