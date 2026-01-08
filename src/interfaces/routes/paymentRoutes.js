/**
 * paymentRoutes.js
 * Express routes for Payment handling.
 */
import express from 'express';
import PaymentService from '../../services/PaymentService.js';

const router = express.Router();

/**
 * GET /banks
 * Returns list of PSE banks.
 */
router.get('/banks', async (req, res) => {
    try {
        const banks = await PaymentService.getBanksList();
        res.json({ success: true, banks });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /initiate
 * Starts the payment flow.
 * Body: { userId, courseId, amount, fullName, email, phone, dni, bankCode, userType, ipAddress, userAgent }
 */
router.post('/initiate', async (req, res) => {
    try {
        // Collect IP/UserAgent if not provided in body (though body is safer if proxy involved)
        const ip = req.body.ipAddress || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ua = req.body.userAgent || req.headers['user-agent'];
        
        const paymentData = {
             ...req.body,
             ipAddress: ip,
             userAgent: ua
        };

        const result = await PaymentService.initiatePayment(paymentData);
        // Return flattened response to match Android DTO
        res.json({ success: true, ...result });
    } catch (error) {
        console.error("Payment Init Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /webhook
 * Endpoint called by PayU/PSE to notify status changes.
 */
router.post('/webhook', async (req, res) => {
    try {
        await PaymentService.handleWebhook(req.body);
        res.status(200).send('OK'); // PayU expects 200 OK
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Error processing webhook');
    }
});

export default router;
