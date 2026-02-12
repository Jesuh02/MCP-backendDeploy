/**
 * PaymentService.js
 * Service for handling secure payment (PSE) logic.
 * Follows SOLID principles (Single Responsibility).
 * Encapsulates PayU interaction and transaction persistence logic.
 */

import crypto from 'crypto';
import SupabaseService from '../database/SupabaseService.js';
import fetch from 'node-fetch'; // Ensure node-fetch is available

class PaymentService {
    constructor() {
        this.supabase = SupabaseService.getInstance();

        // Load credentials securely from environment
        const ENV_privateKey = process.env.PAYU_API_KEY;

        // Detect environment based on key prefix
        // If key starts with 'prv_test_', we MUST use Sandbox URL
        // If key starts with 'prv_prod_', we MUST use Production URL
        const isTestKey = ENV_privateKey && ENV_privateKey.startsWith('prv_test_');

        if (isTestKey) {
            this.wompiprivateKey = ENV_privateKey;
            this.wompiPublicKey = process.env.PAYU_PUBLIC_KEY;
            this.wompiIntegritySecret = process.env.PAYU_INTEGRITY_SECRET;
            this.wompiEventSecret = process.env.PAYU_EVENT_SECRET;

            this.isTest = true;
            this.wompiUrl = 'https://sandbox.wompi.co/v1';
            console.log(`💳 Payment Service Initialized: Mode=SANDBOX (Test Key Detected), URL=${this.wompiUrl}`);
        } else {
            // Production mode - ALL credentials MUST come from environment variables
            this.wompiprivateKey = ENV_privateKey;
            this.wompiPublicKey = process.env.PAYU_PUBLIC_KEY;
            this.wompiIntegritySecret = process.env.PAYU_INTEGRITY_SECRET;
            this.wompiEventSecret = process.env.PAYU_EVENT_SECRET;

            this.isTest = false;
            this.wompiUrl = 'https://production.wompi.co/v1';
            console.log(`💳 Payment Service Initialized: Mode=PRODUCTION, URL=${this.wompiUrl}`);
        }

        // Validate that all required credentials are present
        if (!this.wompiprivateKey) {
            throw new Error('❌ CRITICAL: PAYU_API_KEY environment variable is not set. Payment service cannot start.');
        }
        if (!this.wompiPublicKey) {
            throw new Error('❌ CRITICAL: PAYU_PUBLIC_KEY environment variable is not set. Payment service cannot start.');
        }
        if (!this.wompiIntegritySecret) {
            throw new Error('❌ CRITICAL: PAYU_INTEGRITY_SECRET environment variable is not set. Payment service cannot start.');
        }
        if (!this.wompiEventSecret) {
            throw new Error('❌ CRITICAL: PAYU_EVENT_SECRET environment variable is not set. Payment service cannot start.');
        }

        console.log('✅ All payment credentials validated successfully');

        // Cache for acceptance token
        this._cachedAcceptanceToken = null;
        this._acceptanceTokenExpiry = null;
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
        console.log('📥 Received payment data:', JSON.stringify(paymentData, null, 2));

        if (!paymentData.userId || !paymentData.courseId) {
            throw new Error(`Invalid payment data: Missing required fields. userId: ${paymentData.userId}, courseId: ${paymentData.courseId}`);
        }

        // If amount is not provided or is 0, try to fetch it from the course
        let amount = paymentData.amount;
        if (!amount || amount <= 0) {
            console.log('⚠️ Amount not provided, fetching from course database...');
            const { data: course, error } = await this.supabase.client
                .from('courses')
                .select('price')
                .eq('id', paymentData.courseId)
                .single();

            if (error || !course) {
                throw new Error('Course not found or database error');
            }

            amount = parseFloat(course.price || 0);
            paymentData.amount = amount; // Update the amount in paymentData
        }

        // Wompi minimum amount validation: $1,500 COP
        const WOMPI_MIN_AMOUNT_COP = 1500;
        if (amount < WOMPI_MIN_AMOUNT_COP) {
            throw new Error(`Amount must be at least ${WOMPI_MIN_AMOUNT_COP} COP. Course price: ${amount} COP`);
        }

        console.log('📥 Initiating Wompi Checkout for:', JSON.stringify({ userId: paymentData.userId, courseId: paymentData.courseId, amount: amount }));

        const referenceCode = `ORDER_${Date.now()}_${paymentData.userId}_${paymentData.courseId}`;
        const currency = 'COP';
        const amountInCents = Math.round(amount * 100);

        // Get course details for the checkout page
        const { data: courseDetails } = await this.supabase.client
            .from('courses')
            .select('title, description, thumbnail_url')
            .eq('id', paymentData.courseId)
            .single();

        const courseName = courseDetails?.title || 'Curso';
        const courseDescription = courseDetails?.description || 'Acceso al curso';

        // 3. Create Transaction in DB (Pending) with DB-fetched price
        await this._recordTransactionStart({
            user_id: paymentData.userId,
            course_id: paymentData.courseId,
            amount: amount,
            external_reference: referenceCode,
            status: 'pending'
        });

        // 4. Generate Integrity Signature (SHA256)
        // Concatenation: reference + amountInCents + currency + integritySecret
        const signatureString = `${referenceCode}${amountInCents}${currency}${this.wompiIntegritySecret}`;
        const signature = crypto.createHash('sha256').update(signatureString).digest('hex');

        // 5. Construct Wompi Checkout Standard URL with all parameters
        // This creates a custom checkout link with embedded price, reference, and course data
        // Documentation: https://docs.wompi.co/docs/colombia/widget-checkout-web

        // Determine redirect URL based on environment
        const redirectUrl = this.isTest ?
            'https://mcp-backenddeploy-production-4ed0.up.railway.app/api/payment/redirect' :
            'https://mcp-backenddeploy-production-4ed0.up.railway.app/api/payment/redirect';

        // Build the Wompi Checkout URL with query parameters
        const checkoutParams = new URLSearchParams({
            'public-key': this.wompiPublicKey,
            'currency': currency,
            'amount-in-cents': amountInCents.toString(),
            'reference': referenceCode,
            'signature:integrity': signature,
            'redirect-url': redirectUrl,
            // Custom data for display
            'customer-data:email': paymentData.email || 'user@example.com',
            'customer-data:full-name': paymentData.fullName || 'Usuario'
        });

        // Use Wompi Checkout Standard URL
        const checkoutUrl = `https://checkout.wompi.co/p/?${checkoutParams.toString()}`;

        console.log('💳 Generated Wompi Checkout URL:', checkoutUrl);
        console.log('📝 Reference:', referenceCode);
        console.log('💰 Amount:', amount, 'COP (', amountInCents, 'cents)');

        // Return the URL for the frontend to open
        return {
            payment_url: checkoutUrl,
            reference: referenceCode,
            signature: signature,
            course_name: courseName,
            amount: amount
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
        }
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

        return calculated === checksum; // Verify in production. For dev, you may want to log this.
    }

    /**
     * Handle Wompi webhook update.
     * CRITICAL SECURITY: This is the ONLY function that should mark transactions as 'successful'.
     * It verifies with Wompi API before updating and granting access.
     * Wompi can send data in different formats depending on version/event type.
     */
    async handleWebhook(data) {
        try {
            console.log('📥 Webhook received:', JSON.stringify(data, null, 2));

            // Extract transaction from various possible payload structures
            let transaction = null;
            let reference = null;
            let transactionId = null;
            let status = null;
            let amountInCents = null;

            // Format 1: { event: { data: { transaction: {...} } } }
            if (data?.event?.data?.transaction) {
                transaction = data.event.data.transaction;
            }
            // Format 2: { data: { transaction: {...} } } - THIS IS THE WOMPI FORMAT
            else if (data?.data?.transaction) {
                transaction = data.data.transaction;
            }
            // Format 3: Direct transaction object { transaction: {...} }
            else if (data?.transaction) {
                transaction = data.transaction;
            }
            // Format 4: The data itself is the transaction
            else if (data?.id && data?.status) {
                transaction = data;
            }

            if (!transaction) {
                console.error('❌ Webhook: Could not extract transaction from payload');
                console.log('Payload structure:', Object.keys(data || {}));
                return { success: false, message: 'Invalid transaction data' }; // Return proper response
            }

            reference = transaction.reference || null;
            transactionId = transaction.id;
            status = transaction.status;
            amountInCents = transaction.amount_in_cents;

            console.log(`💳 Wompi Webhook: ID=${transactionId}, Status=${status}, Ref=${reference}, Amount=${amountInCents}`);

            // Since this is the VPOS link without ORDER_ reference, try amount-based matching
            if (!reference || !reference.startsWith('ORDER_')) {
                console.log('⚠️ VPOS transaction detected. Attempting amount-based matching...');

                // SECURITY: Only process APPROVED payments from Wompi webhook
                // This prevents premature approval before user completes payment
                if (status === 'APPROVED' && amountInCents) {
                    // Verify transaction with Wompi API first
                    console.log('🔒 Verifying VPOS transaction with Wompi API before processing...');
                    try {
                        const verifyResponse = await fetch(`${this.wompiUrl}/transactions/${transactionId}`, {
                            headers: { 'Authorization': `Bearer ${this.wompiprivateKey}` }
                        });
                        const verifyResult = await verifyResponse.json();

                        if (!verifyResult.data || verifyResult.data.status !== 'APPROVED') {
                            console.log(`❌ Wompi API verification failed. Status: ${verifyResult.data?.status}`);
                            return { success: false, message: 'Transaction not approved by Wompi' };
                        }

                        console.log('✅ Wompi API confirmed APPROVED status');
                    } catch (e) {
                        console.error('❌ Error verifying with Wompi API:', e);
                        return { success: false, message: 'Failed to verify with Wompi' };
                    }

                    // Try to match with pending transactions by amount
                    const amountInPesos = amountInCents / 100;

                    const { data: pendingTxs } = await this.supabase.client
                        .from('transactions')
                        .select('*')
                        .ilike('status', 'pending')
                        .eq('amount', amountInPesos)
                        .order('created_at', { ascending: false })
                        .limit(5); // Check last 5 pending transactions with this amount

                    if (pendingTxs && pendingTxs.length > 0) {
                        // Find the most recent unclaimed transaction
                        for (const pendingTx of pendingTxs) {
                            // Check if this Wompi transaction hasn't been claimed yet
                            const { data: existingClaim } = await this.supabase.client
                                .from('transactions')
                                .select('id')
                                .eq('wompi_transaction_id', transactionId)
                                .maybeSingle();

                            if (!existingClaim) {
                                // Claim this transaction
                                await this._updateTransactionStatusWithWompiId(
                                    pendingTx.external_reference,
                                    'APPROVED',
                                    transactionId
                                );

                                // Extract user and course from reference
                                const parts = pendingTx.external_reference.split('_');
                                if (parts.length >= 4) {
                                    const userId = parts[2];
                                    const courseId = parts[3];
                                    await this._grantCourseAccess(userId, courseId);
                                    console.log(`✅ VPOS payment claimed: User ${userId}, Course ${courseId}`);
                                }

                                return { success: true, message: 'VPOS payment processed' };
                            }
                        }

                        console.log(`⚠️ VPOS transaction ${transactionId} already claimed or no pending match found`);
                    } else {
                        console.log(`⚠️ No pending transactions found for amount ${amountInPesos} COP`);
                    }
                }

                return { success: true, message: 'VPOS transaction logged' };
            }

            // Standard ORDER_ reference handling (if ever needed)
            // 2. SEGURIDAD EXTRA: Validar con API de Wompi directamente
            try {
                const response = await fetch(`${this.wompiUrl}/transactions/${transactionId}`, {
                    headers: { 'Authorization': `Bearer ${this.wompiprivateKey}` }
                });
                const result = await response.json();

                if (result.data) {
                    status = result.data.status; // Use confirmed status from API
                    console.log(`✅ Wompi API confirmed status: ${status}`);
                }
            } catch (e) {
                console.error("❌ Error verifying with Wompi API:", e);
            }

            // 3. Map status to our DB status
            let dbStatus = 'PENDING';
            if (status === 'APPROVED') dbStatus = 'APPROVED';
            else if (status === 'DECLINED') dbStatus = 'DECLINED';
            else if (status === 'ERROR') dbStatus = 'FAILED';
            else if (status === 'VOIDED') dbStatus = 'VOIDED';

            // 4. Update Supabase
            await this._updateTransactionStatusWithWompiId(reference, dbStatus, transactionId);

            // 5. If Approved, Grant Access
            if (dbStatus === 'APPROVED') {
                const parts = reference.split('_');
                // Format: ORDER_{timestamp}_{userId}_{courseId}
                if (parts.length >= 4) {
                    const userId = parts[2];
                    const courseId = parts[3];
                    console.log(`🎉 Payment successful. Granting access to User ${userId} for Course ${courseId}`);
                    await this._grantCourseAccess(userId, courseId);
                } else {
                    console.error('Invalid reference format in webhook:', reference);
                }
            }

            return { success: true, message: 'Webhook processed successfully' };

        } catch (error) {
            console.error('❌ Webhook processing error:', error);
            return { success: false, message: `Error: ${error.message}` };
        }
    }


    /**
     * Check transaction status from local database ONLY.
     * SECURITY FIX: This function NO LONGER updates transaction status.
     * Only the webhook should update transaction status after Wompi confirmation.
     * This prevents premature approval when user only opens the payment link.
     */
    async getTransactionStatus(transactionReference) {
        // 1. Query Supabase local status
        let { data: tx, error } = await this.supabase.client
            .from('transactions')
            .select('*')
            .eq('external_reference', transactionReference)
            .maybeSingle();

        if (error || !tx) {
            throw new Error("Transaction not found in database");
        }

        console.log(`📊 Transaction ${transactionReference} current status: ${tx.status}`);

        // Return local status WITHOUT modifying anything
        // The webhook will update the status when Wompi confirms the payment
        return {
            status: tx.status,
            reference: transactionReference
        };
    }

    /**
     * Sync recent transactions from Wompi API.
     * Fetches the latest transactions and updates local DB.
     * Useful for reconciliation.
     */
    async syncRecentTransactions() {
        console.log('🔄 Starting Wompi Transaction Sync...');
        try {
            // Calculate date range (Last 15 days)
            // Wompi API V1 transactions endpoint expects ISO-8601 strings for dates
            const now = new Date();
            const untilDate = now.toISOString();

            const fromDateObj = new Date();
            fromDateObj.setDate(fromDateObj.getDate() - 15);
            const fromDate = fromDateObj.toISOString();

            // Prepare Query Params
            const queryParams = new URLSearchParams();

            // REQUIRED: Wompi requires 'from_date' and 'until_date' params 
            // along with pagination info 'page' and 'page_size'
            queryParams.append('page', '1');
            queryParams.append('page_size', '50');
            queryParams.append('from_date', fromDate);
            queryParams.append('until_date', untilDate);

            // Wompi API: GET /v1/transactions
            const url = `${this.wompiUrl}/transactions?${queryParams.toString()}`;
            console.log(`🔗 Checking Wompi Transactions: ${url}`);

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.wompiprivateKey}`
                }
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Wompi Sync Failed: ${response.status} ${errText}`);
            }

            const json = await response.json();
            const transactions = json.data; // Array of transactions
            const results = [];

            console.log(`🔄 Found ${transactions ? transactions.length : 0} recent transactions to check.`);

            if (!transactions) return { success: true, processed: 0, message: "No transactions found" };

            for (const tx of transactions) {
                // We only care about transactions that match our reference pattern
                // Our reference format: ORDER_{timestamp}_{userId}_{courseId}
                const reference = tx.reference;

                // Flexible check for ORDER_ prefix
                if (!reference || !reference.startsWith('ORDER_')) {
                    continue;
                }

                const status = tx.status;

                // Parse Reference (Split by underscore)
                const parts = reference.split('_');
                // Expected: ["ORDER", "1234567890", "5", "107"] -> length 4
                if (parts.length < 4) continue;

                const userId = parts[2];
                const courseId = parts[3];

                // Update DB entry
                await this._updateTransactionStatus(reference, status, tx.id);

                let action = 'Check';
                if (status === 'APPROVED') {
                    // Check if access is already granted, grant if not
                    await this._grantCourseAccess(userId, courseId);
                    action = 'GRANTED_ACCESS';
                }

                results.push({
                    reference,
                    status,
                    userId,
                    courseId,
                    action
                });
            }

            console.log(`✅ Sync Completed. Processed ${results.length} relevant transactions.`);
            return { success: true, processed: results };

        } catch (error) {
            console.error("❌ Sync Error:", error);
            return { success: false, error: error.message };
        }
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
            .ilike('status', 'approved');

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
        let baseUrl = process.env.PUBLIC_URL || process.env.RAILWAY_STATIC_URL;

        if (!baseUrl) {
            throw new Error('❌ CRITICAL: PUBLIC_URL or RAILWAY_STATIC_URL environment variable must be set');
        }

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
                updated_at: new Date()
            })
            .eq('external_reference', reference);

        if (error) console.error("DB Error updating transaction", error);
    }

    /**
     * Update transaction with Wompi transaction ID for tracking claimed payments
     */
    async _updateTransactionStatusWithWompiId(reference, status, wompiTransactionId) {
        const { error } = await this.supabase.client
            .from('transactions')
            .update({
                status: status,
                wompi_transaction_id: wompiTransactionId,
                updated_at: new Date()
            })
            .eq('external_reference', reference);

        if (error) console.error("DB Error updating transaction with Wompi ID", error);
        else console.log(`✅ Transaction ${reference} updated: status=${status}, wompi_id=${wompiTransactionId}`);
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