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
        
        // Load credentials securely from environment
        // The user provided Wompi-style keys (pub_test_, prv_test_).
        // For robustness, we map them here.
        this.wompiPublicKey = process.env.PAYU_PUBLIC_KEY; 
        this.wompiprivateKey = process.env.PAYU_API_KEY; 
        this.wompiIntegritySecret = process.env.PAYU_INTEGRITY_SECRET;
        this.wompiEventSecret = process.env.PAYU_EVENT_SECRET;
        
        // Auto-detect environment based on key prefix (pub_test_ vs pub_prod_)
        // This overrides NODE_ENV to allow testing in production deployments
        const hasTestKey = this.wompiPublicKey && (this.wompiPublicKey.includes('test') || this.wompiPublicKey.includes('sbx'));
        
        this.isTest = hasTestKey || process.env.NODE_ENV !== 'production';
        this.wompiUrl = this.isTest 
            ? 'https://sandbox.wompi.co/v1' 
            : 'https://production.wompi.co/v1'; 
        
        console.log(`💳 Payment Service Initialized: Mode=${this.isTest ? 'TEST/SANDBOX' : 'PRODUCTION'}, URL=${this.wompiUrl}`);
    }

    /**
     * Start a payment transaction using Wompi (implied by the keys provided).
     * 1. Validate inputs
     * 2. Calculate secure signature
     * 3. Send request to Wompi
     * 4. Persist initial transaction state PENDING
     * @param {Object} paymentData - { userId, courseId, amount, ipAddress, userAgent, payerDocType, payerDocNumber, payerEmail, bankCode, ... }
     */
    async initiatePayment(paymentData) {
        // 1. Validation
        if (!paymentData.userId || !paymentData.courseId || !paymentData.amount) {
            throw new Error('Invalid payment data: Missing userId, courseId, or amount');
        }
        
        // Validate document fields (required by Wompi)
        const docType = paymentData.payerDocType || 'CC';
        const docNumber = paymentData.payerDocNumber;
        if (!docNumber) {
            throw new Error('Invalid payment data: Missing document number (payerDocNumber)');
        }
        
        // Validate email
        const email = paymentData.payerEmail || paymentData.email;
        if (!email) {
            throw new Error('Invalid payment data: Missing email');
        }
        
        // Validate bank code
        const bankCode = paymentData.bankCode;
        if (!bankCode) {
            throw new Error('Invalid payment data: Missing bankCode');
        }

        console.log('📝 Payment Request Data:', {
            userId: paymentData.userId,
            courseId: paymentData.courseId,
            amount: paymentData.amount,
            docType,
            docNumber: docNumber ? `${docNumber.substring(0, 3)}***` : 'MISSING',
            email: email ? `${email.substring(0, 3)}***` : 'MISSING',
            bankCode
        });

        const referenceCode = `TX-${Date.now()}-${paymentData.userId}-${paymentData.courseId}`;
        const currency = 'COP';
        const amountInCents = Math.round(paymentData.amount * 100); // Wompi requires amounts in cents
        
        // 2. Create Transaction in DB (Pending)
        await this._recordTransactionStart({
            user_id: paymentData.userId,
            course_id: paymentData.courseId,
            amount: paymentData.amount,
            external_reference: referenceCode,
            status: 'PENDING'
        });

        // 3. Generate Signature for Integrity (SHA256)
        // Concatenation: reference + amountInCents + currency + integritySecret
        const signatureString = `${referenceCode}${amountInCents}${currency}${this.wompiIntegritySecret}`;
        const signature = crypto.createHash('sha256').update(signatureString).digest('hex');

        // 4. Build Wompi payload with proper field mapping
        // Map document types: Wompi accepts RC, TI, CC, TE, CE, NIT, PP, DNI
        const validDocTypes = ['RC', 'TI', 'CC', 'TE', 'CE', 'NIT', 'PP', 'DNI'];
        const wompiDocType = validDocTypes.includes(docType.toUpperCase()) ? docType.toUpperCase() : 'CC';
        
        const payload = {
            acceptance_token: paymentData.acceptanceToken, // May be null for PSE
            amount_in_cents: amountInCents,
            currency: currency,
            signature: signature,
            customer_email: email, // Map payerEmail -> customer_email
            payment_method: {
                type: "PSE",
                user_type: wompiDocType === 'NIT' ? 1 : 0, // 0 = Person, 1 = Company
                user_legal_id_type: wompiDocType, // Map payerDocType -> user_legal_id_type
                user_legal_id: docNumber, // Map payerDocNumber -> user_legal_id
                payment_description: `Course Purchase: ${paymentData.courseId}`,
                financial_institution_code: bankCode
            },
            reference: referenceCode,
            redirect_url: this._getRedirectUrl()
        };
        
        // Add sandbox_status only in test mode
        if (this.isTest) {
            payload.payment_method.sandbox_status = "APPROVED";
        }

        console.log('📤 Wompi Request Payload:', JSON.stringify(payload, null, 2));

        // Note: Wompi API call requires Bearer token with Private Key for backend calls
        const response = await fetch(`${this.wompiUrl}/transactions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.wompiprivateKey}`, // Use PRIVATE key for backend transactions
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        console.log('📥 Wompi Response:', JSON.stringify(result, null, 2));
        
        if (result.error) {
            throw new Error(`Wompi Error: ${JSON.stringify(result.error)}`);
        }
        
        // Return the bank URL
        return {
           urlBankPayment: result.data?.payment_method?.extra?.async_payment_url, // URL to redirect user to bank
           transactionId: result.data?.id
        };
    }

    /**
     * Get list of banks from Wompi for PSE.
     */
    async getBanksList() {
        // Wompi doesn't provide banks endpoint like PayU
        // Return a hardcoded list of Colombian banks for PSE
        return [
            { code: '1040', description: 'Banco Agrario' },
            { code: '1507', description: 'NEQUI' },
            { code: '1551', description: 'Daviplata' },
            { code: '1001', description: 'Banco de Bogotá' },
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

        // 3. If Approved, Grant Access
        if (dbStatus === 'APPROVED') {
            await this._grantCourseAccess(userId, courseId);
        }
    }

    // --- Private Helpers ---

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
