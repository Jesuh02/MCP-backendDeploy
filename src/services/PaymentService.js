/**
 * PaymentService.js
 * Service for handling secure payment (PSE) logic.
 * Follows SOLID principles (Single Responsibility).
 * Encapsulates PayU interaction and transaction persistence logic.
 */

import crypto from 'crypto';
import SupabaseService from '../infrastructure/database/SupabaseService.js';
import fetch from 'node-fetch'; // Ensure node-fetch is available

class PaymentService {
    constructor() {
        this.supabase = SupabaseService.getInstance();
        
        // Load credentials securely from environment, with provided fallbacks
        this.wompiPublicKey = process.env.PAYU_PUBLIC_KEY || 'pub_prod_Z2EDqHyoboyqtZeFM1o2LzMo29Y9IOZY'; 
        this.wompiprivateKey = process.env.PAYU_API_KEY || 'prv_prod_1HtekzWgmIlKMDmsYLx9lChHFTdtZQ3k'; 
        this.wompiIntegritySecret = process.env.PAYU_INTEGRITY_SECRET || 'prod_integrity_lmrPPePMkcVxQh8TK3Xcmj4vIrh25ybG';
        this.wompiEventSecret = process.env.PAYU_EVENT_SECRET || 'prod_events_mM1eK9OkFgrr9UYtgnnFVQGdlc4oFoGj';
        
        // Force production URL as per provided production keys
        this.isTest = false;
        this.wompiUrl = 'https://production.wompi.co/v1'; 
        
        // Cache for acceptance token
        this._cachedAcceptanceToken = null;
        this._acceptanceTokenExpiry = null;
        
        console.log(`💳 Payment Service Initialized: Mode=PRODUCTION, URL=${this.wompiUrl}`);
    }

    /**
     * Fetch acceptance token from Wompi.
     * This token represents user's acceptance of Wompi's terms & conditions.
     * Required for all transactions.
     */
    async _getAcceptanceToken() {
        // Wompi acceptance tokens are single-use. Always fetch a new one.
        if (!this.wompiPublicKey) {
            throw new Error('Internal Error: WOMPI Public Key is not configured (PAYU_PUBLIC_KEY env var)');
        }
        
        try {
            const url = `${this.wompiUrl}/merchants/${this.wompiPublicKey}`;
            console.log(`🔑 Fetching acceptance token from Wompi: ${url}`);
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const result = await response.json();
            // Log full response to debug "No está presente" issues
            console.log('PaymentService: Merchant/Token Response:', JSON.stringify(result, null, 2));
            
            if (result.data && result.data.presigned_acceptance) {
                const { acceptance_token, permalink } = result.data.presigned_acceptance;
                
                if (!acceptance_token) {
                     console.error('❌ Acceptance token field is missing in response data:', result.data);
                     throw new Error('Wompi returned success but acceptance_token is missing');
                }

                console.log('✅ Acceptance token obtained. Terms URL:', permalink);
                
                return acceptance_token;
            } else {
                console.error('❌ Failed to get acceptance token. Result:', JSON.stringify(result));
                throw new Error('No se pudo obtener el token de aceptación de Wompi. Verifique la llave pública.');
            }
        } catch (error) {
            console.error('❌ Error fetching acceptance token:', error);
            throw new Error(`Error obteniendo token de aceptación: ${error.message}`);
        }
    }

    /**
     * Start a payment transaction using Wompi Checkout URL.
     * Generates a signed URL for the frontend to redirect the user to.
     * @param {Object} paymentData - { userId, courseId, amount, ... }
     */
    async initiatePayment(paymentData) {
        // 1. Validation
        if (!paymentData.userId || !paymentData.courseId || !paymentData.amount) {
            throw new Error('Invalid payment data: Missing userId, courseId, or amount');
        }
        
        // Wompi minimum amount validation: $1,500 COP
        const WOMPI_MIN_AMOUNT_COP = 1500;
        if (paymentData.amount < WOMPI_MIN_AMOUNT_COP) {
            throw new Error(`Amount must be at least ${WOMPI_MIN_AMOUNT_COP} COP`);
        }
        
        console.log('📥 Initiating Wompi Checkout for:', JSON.stringify({ userId: paymentData.userId, courseId: paymentData.courseId, amount: paymentData.amount }));

        const referenceCode = `TX-${Date.now()}-${paymentData.userId}-${paymentData.courseId}`;
        const currency = 'COP';
        const amountInCents = Math.round(paymentData.amount * 100); 
        
        // 2. Create Transaction in DB (Pending)
        await this._recordTransactionStart({
            user_id: paymentData.userId,
            course_id: paymentData.courseId,
            amount: paymentData.amount,
            external_reference: referenceCode,
            status: 'PENDING'
        });

        // 3. Generate Integrity Signature (SHA256)
        // Concatenation: reference + amountInCents + currency + integritySecret
        const signatureString = `${referenceCode}${amountInCents}${currency}${this.wompiIntegritySecret}`;
        const signature = crypto.createHash('sha256').update(signatureString).digest('hex');

        // 4. Construct Wompi Checkout URL
        const redirectUrl = this._getRedirectUrl();
        const checkoutUrl = `https://checkout.wompi.co/p/?public-key=${this.wompiPublicKey}&currency=${currency}&amount-in-cents=${amountInCents}&reference=${referenceCode}&signature:integrity=${signature}&redirect-url=${encodeURIComponent(redirectUrl)}`;

        // Return the URL for the frontend to open
        return { 
            payment_url: checkoutUrl,
            reference: referenceCode,
            signature: signature
        };
    }

    /**
     * Get list of banks from Wompi for PSE.
     */
    async getBanksList() {
        // Wompi expects public key for getting banks (GET /v1/pse/financial_institutions)
        try {
            const response = await fetch(`${this.wompiUrl}/pse/financial_institutions`, {
                 headers: { 'Authorization': `Bearer ${this.wompiPublicKey}` }
            });
            const result = await response.json();
            if (result.data) return result.data;
            return [];
        } catch (e) {
            console.error("Error fetching banks:", e);
            // Fallback list
            return [
                { financial_institution_code: '1001', financial_institution_name: 'Banco de Bogotá' },
                { financial_institution_code: '1051', financial_institution_name: 'Davivienda' },
                { financial_institution_code: '1007', financial_institution_name: 'Bancolombia' },
                { financial_institution_code: '1507', financial_institution_name: 'NEQUI' }
            ];
        }            { code: '1001', description: 'Banco de Bogotá' },
            { code: '1002', description: 'Banco Popular' },
            { code: '1019', description: 'Scotiabank Colpatria' },
            { code: '1051', description: 'Banco Davivienda' },
            { code: '1052', description: 'Banco AV Villas' },
            { code: '1059', description: 'Bancamia' },
            { code: '1060', description: 'Banco Pichincha' },
            { code: '1061', description: 'Bancoomeva' },
            { code: '1062', description: 'Banco Falabella' },
            { code: '1063', description: 'Banco Finandina' },
            { code: '1064', description: 'Banco GNB Sudameris' },
            { code: '1065', description: 'Banco Santander' },
            { code: '1066', description: 'Banco Cooperativo Coopcentral' },
            { code: '1067', description: 'Banco Caja Social' },
            { code: '1303', description: 'Banco Caja Social' },
            { code: '1292', description: 'Confiar' },
            { code: '1289', description: 'Cotrafa' },
            { code: '1283', description: 'Cooperativa Financiera de Antioquia' },
            { code: '1058', description: 'Banco Procredit' },
            { code: '1012', description: 'Banco GNB Colombia (antes BBVA)' },
            { code: '1032', description: 'Banco Occidente' },
            { code: '1013', description: 'Banco BBVA Colombia' }
        ];
    }

    /**
     * Verify Webhook Signature from Wompi.
     * Security critical: Ensures the request comes from Wompi.
     */
    verifyWebhookSignature(reqBody) {
        // Wompi signature verification
        // signature = SHA256(event.data.transaction.id + event.data.transaction.status + event.data.transaction.amount_in_cents + event.timestamp + integritySecret)
        const { event } = reqBody;
        if (!event || !event.data || !event.data.transaction) {
            return false;
        }
        
        const txId = event.data.transaction.id;
        const status = event.data.transaction.status;
        const amount = event.data.transaction.amount_in_cents;
        const timestamp = event.timestamp;
        const checksum = event.signature?.checksum;
        
        if (!checksum) return false;
        
        const signatureString = `${txId}${status}${amount}${timestamp}${this.wompiEventSecret}`;
        const calculated = crypto.createHash('sha256').update(signatureString).digest('hex');
        
        return calculated === checksum;
    }

    /**
     * Handle Wompi webhook update.
     * Updates transaction status and grants access if approved.
     */
    async handleWebhook(data) {
        // 1. Verify security signature
        if (!this.verifyWebhookSignature(data)) {
            throw new Error("Invalid webhook signature");
        }

        const { event } = data;
        const transaction = event.data.transaction;
        const reference = transaction.reference;
        const status = transaction.status; // APPROVED, DECLINED, PENDING, ERROR
        const transactionId = transaction.id;

        let dbStatus = 'PENDING';
        if (status === 'APPROVED') dbStatus = 'APPROVED';
        else if (status === 'DECLINED') dbStatus = 'REJECTED';
        else if (status === 'ERROR') dbStatus = 'FAILED';

        console.log(`💳 Wompi Webhook received for ${reference}: Status ${status} -> ${dbStatus}`);

        // 2. Parse userId and courseId from reference
        // Format: TX-{timestamp}-{userId}-{courseId}
        const parts = reference.split('-');
        if (parts.length < 4) {
            console.error('Invalid reference format:', reference);
            return;
        }
        
        const userId = parts[2];
        const courseId = parts[3];

        await this._updateTransactionStatus(reference, dbStatus, transactionId);

        // 3. If Approved, Check Amount and Grant Access if Complete
        if (dbStatus === 'APPROVED') {
            const completeness = await this._checkPaymentCompleteness(userId, courseId);
            if (completeness.isComplete) {
                await this._grantCourseAccess(userId, courseId);
            } else {
                console.log(`⚠️ Payment Approved but partial/insufficient. Paid: ${completeness.paid} / Required: ${completeness.required}`);
            }
        }
    }

    /**
     * Check transaction status directly from Wompi and update DB.
     * Useful when webhooks fail or in local/sandbox environments.
     */
    async getTransactionStatus(transactionId) {
        // 1. First check local DB by external_reference (Wompi ID)
        let { data: tx } = await this.supabase.client
            .from('transactions')
            .select('*')
            .eq('external_reference', transactionId)
            .maybeSingle();

        // 2. Poll Wompi if needed (if not final or explicitly requested)
        // For simplicity, we always poll Wompi to be sure in Sandbox
        let wompiResult = null;
        try {
            console.log(`🔎 Polling Wompi for status: ${transactionId}`);
            const response = await fetch(`${this.wompiUrl}/transactions/${transactionId}`, {
                method: 'GET'
            }); 
            
            const result = await response.json();
            if (result.data) {
                wompiResult = result.data;
            }
        } catch (error) {
            console.error("Error polling Wompi:", error);
        }

        let currentStatus = tx ? tx.status : 'UNKNOWN';
        let reference = tx ? tx.external_reference : null; // This might be wrong field mapping, reference is usually 'reference' column
        // In DB: external_reference maps to Wompi ID usually? 
        // Let's use the reference code (TX-...) if available
        let referenceCode = tx ? (tx.reference || tx.external_reference) : null; 
        
        let userId = tx ? tx.user_id : null;
        let courseId = tx ? tx.course_id : null;

        if (wompiResult) {
            const wompiStatus = wompiResult.status;
            referenceCode = wompiResult.reference; // Trust Wompi reference code
            
            // Map status
            if (wompiStatus === 'APPROVED') currentStatus = 'APPROVED';
            else if (wompiStatus === 'DECLINED') currentStatus = 'REJECTED';
            else if (wompiStatus === 'ERROR' || wompiStatus === 'VOIDED') currentStatus = 'FAILED';

            // Parse ID from reference if we didn't have it
            if (!userId || !courseId) {
                const parts = referenceCode.split('-');
                if (parts.length >= 4) {
                    userId = parts[2];
                    courseId = parts[3];
                }
            }

            // Update DB
            // Use external_reference = transactionId to match the row
            if (currentStatus !== 'PENDING') {
                await this._updateTransactionStatus(referenceCode, currentStatus, transactionId);
            }
        }

        const responseObj = { 
            status: currentStatus, 
            source: wompiResult ? 'WOMPI' : 'DB' 
        };

        // 3. Check for Completeness and Grant Access if Approved
        if (currentStatus === 'APPROVED' && userId && courseId) {
             const completeness = await this._checkPaymentCompleteness(userId, courseId);
             
             if (completeness.isComplete) {
                 await this._grantCourseAccess(userId, courseId);
                 responseObj.accessGranted = true;
             } else {
                 responseObj.accessGranted = false;
                 responseObj.partial = true;
             }
             
             // Attach financial details for frontend
             responseObj.paymentDetails = {
                 paid: completeness.paid,
                 required: completeness.required,
                 remaining: completeness.remaining,
                 isComplete: completeness.isComplete
             };
        } else if (userId && courseId) {
             // Even if not approved, return what we know about price
              const completeness = await this._checkPaymentCompleteness(userId, courseId);
              responseObj.paymentDetails = {
                 paid: completeness.paid,
                 required: completeness.required,
                 remaining: completeness.remaining,
                 isComplete: completeness.isComplete
             };
        }

        return responseObj;
    }

    // --- Private Helpers ---

    async _checkPaymentCompleteness(userId, courseId) {
        // 1. Get Course Price
        const { data: course, error: cErr } = await this.supabase.client
            .from('courses')
            .select('price')
            .eq('id', courseId)
            .single();
        
        if (cErr || !course) return { isComplete: false, error: 'Course not found', paid: 0, required: 0, remaining: 0 };

        const price = parseFloat(course.price || 0);
        if (price <= 0) return { isComplete: true, paid: 0, required: 0, remaining: 0 }; // Free course

        // 2. Get Total Approved Payments
        const { data: txs, error: tErr } = await this.supabase.client
            .from('transactions')
            .select('amount')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .eq('status', 'APPROVED');
        
        if (tErr) return { isComplete: false, error: 'DB Error', paid: 0, required: 0, remaining: 0 };

        const totalPaid = txs.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
        const remaining = Math.max(0, price - totalPaid);
        
        // Allow small margin of error (e.g. 100 COP)
        const isComplete = remaining < 100; 

        return { 
            isComplete, 
            paid: totalPaid, 
            required: price, 
            remaining 
        };
    }

    _getRedirectUrl() {
        let baseUrl = process.env.PUBLIC_URL || process.env.RAILWAY_STATIC_URL || 'https://mcp-backenddeploy-production.up.railway.app';
        
        // Ensure https:// prefix if missing
        if (!baseUrl.startsWith('http')) {
            baseUrl = `https://${baseUrl}`;
        }
        
        // Remove trailing slash if present to avoid double slashes
        if (baseUrl.endsWith('/')) {
            baseUrl = baseUrl.slice(0, -1);
        }
        
        return `${baseUrl}/payment/confirm`;
    }

    async _recordTransactionStart(txData) {
        // Insert into 'transactions' table via SupabaseService
        // Assuming we have a helper for insert
        const { error } = await this.supabase.client
            .from('transactions')
            .insert([txData]);
            
        if (error) {
            console.error("DB Error inserting transaction", error);
            throw error;
        }
    }

    async _updateTransactionStatus(reference, status, transactionId) {
        const { error } = await this.supabase.client
            .from('transactions')
            .update({ 
                status: status, 
                external_reference: transactionId, 
                updated_at: new Date() 
            })
            .eq('external_reference', reference);
            
        if (error) console.error("DB Error updating transaction", error);
    }

    async _grantCourseAccess(userId, courseId) {
        // Strategy: Insert into progreso_estudiante to unlock course enrollment
        const { error } = await this.supabase.client
            .from('progreso_estudiante')
            .upsert({ 
                usuario_estudiante: userId, 
                curso_id: courseId, 
                creado_en: new Date()
            }, { onConflict: ['usuario_estudiante', 'curso_id'] });

        if (error) console.error("Error granting course access", error);
        else console.log(`✅ Access granted for user ${userId} to course ${courseId}`);
    }
}

export default new PaymentService();
