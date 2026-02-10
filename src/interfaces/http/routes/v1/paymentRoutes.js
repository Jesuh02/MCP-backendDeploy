import { Router } from 'express';

export function paymentRoutes({ paymentController }) {
    const router = Router();

    router.post('/initiate', paymentController.initiate);
    router.get('/status/:transactionId', paymentController.checkStatus);
    router.get('/my', paymentController.getMyTransactions);
    router.get('/banks', paymentController.getBanks);
    router.get('/purchased/:courseId', paymentController.hasPurchased);
    router.post('/webhook', paymentController.webhook); // No auth needed for webhook

    return router;
}
export default paymentRoutes;