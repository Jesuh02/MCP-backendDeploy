/**
 * paymentRoutes.js
 * Express routes for Payment handling.
 */
import express from 'express';
import crypto from 'crypto';
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
        // Backend returns: { payment_url, reference, signature, course_name, amount }
        // Android expects: { urlBankPayment, transactionId, message, courseName, amount }
        res.json({ 
            success: true, 
            urlBankPayment: result.payment_url, 
            transactionId: result.reference,
            courseName: result.course_name,
            amount: result.amount,
            message: `Pagar $${result.amount.toLocaleString()} COP por ${result.course_name}`
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
        // SECURITY: Verify Wompi Integrity Signature
        const body = req.body;
        // Normalize payload: handle wrapped event (Format 1) vs direct event (Format 2/Standard)
        const eventData = (body.event && body.event.data) ? body.event : body;
        
        const { data, signature, timestamp } = eventData;
        
        // If it looks like a transaction event, strictly enforce signature verification
        if (data && data.transaction) {
            if (!signature || !signature.checksum || !timestamp) {
                console.warn('⚠️ Webhook missing integrity signature or timestamp');
                return res.status(400).json({ success: false, message: 'Missing integrity signature' });
            }

            const secret = PaymentService.wompiEventSecret; 
            if (!secret) {
                console.error('❌ Critical: PaymentService.wompiEventSecret is missing');
                return res.status(500).json({ success: false, message: 'Server configuration error' });
            }

            const tx = data.transaction;
            const signatureString = `${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${secret}`;
            const calculatedChecksum = crypto.createHash('sha256').update(signatureString).digest('hex');
            
            if (calculatedChecksum !== signature.checksum) {
                console.error(`❌ Webhook Signature Mismatch! Calculated: ${calculatedChecksum}, Received: ${signature.checksum}`);
                return res.status(400).json({ success: false, message: 'Invalid integrity signature' });
            }
        }

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

/**
 * GET /redirect
 * Redirect endpoint after Wompi payment completion.
 * Wompi redirects here with transaction ID in query params.
 * This page shows a success/failure message and provides a deep link back to the app.
 */
router.get('/redirect', async (req, res) => {
    try {
        const { id: transactionId, reference: queryReference } = req.query;
        
        console.log('📥 Payment redirect received:', req.query);
        
        // SECURITY FIX: Don't check or update status here
        // User just opened the link, payment is still processing
        // The webhook will update the status when Wompi confirms
        const status = 'pending';
        const message = 'Tu pago está siendo procesado. Recibirás una confirmación pronto.';
        const reference = queryReference || transactionId || '';
        
        // Return a simple HTML page that redirects to the app
        const html = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YisusCompany - Pago</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            max-width: 400px;
        }
        .icon {
            font-size: 80px;
            margin-bottom: 20px;
        }
        .success { color: #4CAF50; }
        .pending { color: #FF9800; }
        .failed { color: #f44336; }
        h1 {
            font-size: 24px;
            margin-bottom: 16px;
        }
        p {
            font-size: 16px;
            opacity: 0.8;
            margin-bottom: 30px;
        }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px 32px;
            border-radius: 30px;
            text-decoration: none;
            font-weight: bold;
            font-size: 16px;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s;
        }
        .btn:hover { transform: scale(1.05); }
        .ref {
            margin-top: 20px;
            font-size: 12px;
            opacity: 0.5;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon ${status === 'successful' || status === 'APPROVED' ? 'success' : status === 'pending' ? 'pending' : 'failed'}">
            ${status === 'successful' || status === 'APPROVED' ? '✅' : status === 'pending' ? '⏳' : '❌'}
        </div>
        <h1>${status === 'successful' || status === 'APPROVED' ? '¡Pago Exitoso!' : status === 'pending' ? 'Procesando Pago' : 'Pago No Completado'}</h1>
        <p>${message}</p>
        <a href="yisuscompany://payment-complete?status=${status}&reference=${reference}" class="btn">
            Volver a la App
        </a>
        <p class="ref">Ref: ${reference || transactionId || 'N/A'}</p>
    </div>
    <script>
        // Try to open the app automatically after 2 seconds
        setTimeout(() => {
            window.location.href = 'yisuscompany://payment-complete?status=${status}&reference=${reference}';
        }, 2000);
    </script>
</body>
</html>
        `;
        
        res.send(html);
    } catch (error) {
        console.error("Redirect Error:", error);
        res.status(500).send('Error procesando la redirección');
    }
});

export default router;
