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
 * Body: { userId, courseId } - amount will be fetched from courses table
 */
router.post('/initiate', async (req, res) => {
    try {
        // Validate required fields only (amount will be fetched from DB)
        if (!req.body.userId || !req.body.courseId) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields: userId, courseId' 
            });
        }
        
        // Collect IP/UserAgent if not provided in body (though body is safer if proxy involved)
        const ip = req.body.ipAddress || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ua = req.body.userAgent || req.headers['user-agent'];
        
        // Fetch course price from database for security
        const { data: course, error: courseError } = await PaymentService.supabase.client
            .from('courses')
            .select('price')
            .eq('id', req.body.courseId)
            .single();
        
        if (courseError || !course) {
            return res.status(400).json({ success: false, message: 'Course not found' });
        }
        
        const coursePrice = parseFloat(course.price || 0);
        if (coursePrice <= 0) {
            return res.status(400).json({ success: false, message: 'This course is free, no payment required' });
        }

        const paymentData = {
             userId: req.body.userId,
             courseId: req.body.courseId,
             amount: coursePrice,
             fullName: req.body.payerName || req.body.fullName || 'Usuario',
             email: req.body.payerEmail || req.body.email || 'user@example.com',
             phone: req.body.phone || '3000000000',
             dni: req.body.payerDocNumber || req.body.dni || '12345678',
             bankCode: req.body.bankCode || '0',
             userType: req.body.userType || '0',
             ipAddress: ip,
             userAgent: ua
        };

        const result = await PaymentService.initiatePayment(paymentData);
        // Map backend response fields to match Android PaymentInitiationResponse DTO
        // Backend returns: { payment_url, reference, signature }
        // Android expects: { urlBankPayment, transactionId, message }
        res.json({ 
            success: true, 
            urlBankPayment: result.payment_url, 
            transactionId: result.reference,
            message: "Redirigiendo a Wompi..."
        });
    } catch (error) {
        console.error("Payment Init Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /webhook
 * Endpoint called by Wompi to notify status changes.
 */
router.post('/webhook', async (req, res) => {
    try {
        const result = await PaymentService.handleWebhook(req.body);
        
        // Wompi expects a proper JSON response
        res.status(200).json({
            success: result.success,
            message: result.message
        });
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(200).json({
            success: false,
            message: `Error: ${error.message}`
        });
    }
});

/**
 * GET /status/:transactionId
 * Checks the status of a specific transaction.
 * Polls Wompi directly if necessary (useful for sandbox/no-webhook envs).
 */
router.get('/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        const result = await PaymentService.getTransactionStatus(transactionId);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error("Status Check Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /sync
 * Manually triggers a reconciliation with Wompi to catch any missing transactions.
 * Useful developer tool or cron job endpoint.
 */
router.get('/sync', async (req, res) => {
    try {
        const result = await PaymentService.syncRecentTransactions();
        res.json(result);
    } catch (error) {
        console.error("Sync Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
