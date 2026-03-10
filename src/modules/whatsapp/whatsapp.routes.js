import { Router } from 'express';

export function whatsappRoutes({ whatsAppController, authMiddleware }) {
    const router = Router();

    router.get('/webhook', whatsAppController.verifyWebhook);
    router.post('/webhook', whatsAppController.handleWebhook);

    router.use(authMiddleware);
    router.post('/link', whatsAppController.linkAccount);
    router.post('/verify', whatsAppController.verifyOtp);
    router.post('/unlink', whatsAppController.unlinkAccount);
    router.get('/status', whatsAppController.getStatus);

    return router;
}

export default whatsappRoutes;


