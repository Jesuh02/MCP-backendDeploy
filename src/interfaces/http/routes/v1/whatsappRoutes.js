/**
 * whatsappRoutes — Rutas Express para el módulo WhatsApp.
 *
 * Rutas públicas (webhook de Meta):
 *   GET  /webhook  → Verificación
 *   POST /webhook  → Recepción de mensajes
 *
 * Rutas protegidas (requieren JWT):
 *   POST /link     → Vincular cuenta
 *   POST /verify   → Verificar OTP
 *   POST /unlink   → Desvincular cuenta
 *   GET  /status   → Estado de vinculación
 */
import { Router } from 'express';

/**
 * @param {object} deps — Dependencias inyectadas desde el container.
 * @returns {Router}
 */
export function whatsappRoutes({ whatsAppController, authMiddleware }) {
    const router = Router();

    // ── Rutas públicas (Meta webhook — sin auth) ────────────
    router.get('/webhook', whatsAppController.verifyWebhook);
    router.post('/webhook', whatsAppController.handleWebhook);

    // ── Rutas protegidas (requieren JWT) ────────────────────
    router.use(authMiddleware);
    router.post('/link', whatsAppController.linkAccount);
    router.post('/verify', whatsAppController.verifyOtp);
    router.post('/unlink', whatsAppController.unlinkAccount);
    router.get('/status', whatsAppController.getStatus);

    return router;
}

export default whatsappRoutes;
