import { Result } from '../../shared/Result.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';
import crypto from 'crypto';

export class PaymentDomainService {
    constructor({ transactionRepository, courseRepository, paymentGatewayPort, progressRepository, outboxRepo }) {
        this.txRepo = transactionRepository;
        this.courseRepo = courseRepository;
        this.gateway = paymentGatewayPort;
        this.progressRepo = progressRepository || null;
        this.outboxRepo = outboxRepo || null;
    }

    async initiate({ userId, courseId, redirectUrl }) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        if (course.is_free) return Result.fail(new ValidationError('Este curso es gratuito'));

        // 1. Verificar si ya compró el curso (Evitar duplicados exitosos)
        const alreadyPurchased = await this.txRepo.hasSuccessfulPurchase(userId, courseId);
        if (alreadyPurchased) {
            return Result.fail(new ValidationError('User already owns this course'));
        }

        const priceInPesos = parseFloat(course.price || 0);
        const amountInCents = Math.round(priceInPesos * 100);
        if (amountInCents <= 0) return Result.fail(new ValidationError('Precio inválido'));

        const reference = `CV-${userId}-${courseId}-${Date.now()}`;

        // 2. Verificar si hay una transacción PENDIENTE y reutilizarla (Evitar duplicados pendientes)
        // Esto soluciona que se creen múltiples registros 'pending' sin necesidad.
        const pendingTx = await this.txRepo.findPending(userId, courseId);
        let tx;

        if (pendingTx) {
            // Actualizamos la transacción existente con la nueva referencia
            // Así mantenemos 1 registro único hasta que se apruebe
            tx = await this.txRepo.update(pendingTx.id, {
                externalReference: reference,
                // Aseguramos que la referencia se actualice en ambas columnas si es necesario
                transactionId: reference,
                amount: priceInPesos,
                updated_at: new Date(),
                status: 'PENDING'
            });
        } else {
            // Crear nueva transacción solo si no existe una pendiente
            tx = await this.txRepo.create({
                userId,
                courseId,
                amount: priceInPesos,
                currency: 'COP',
                status: 'PENDING',
                paymentMethod: 'pse',
                externalReference: reference,
            });
        }

        // Generar URL de checkout
        const redirectBase = redirectUrl || 'https://mcp-backenddeploy-production-4ed0.up.railway.app/api/payment/redirect';
        const checkout = await this.gateway.initiatePayment({
            amountInCents,
            currency: 'COP',
            reference,
            redirectUrl: redirectBase,
        });

        return Result.ok({
            ...checkout,
            transactionDbId: tx.id,
            reference,
            amount: priceInPesos,
            courseName: course.title || 'Curso',
        });
    }

    async checkStatus(transactionId) {
        // Try to find by reference in both columns (transaction_id and external_reference)
        const tx = (this.txRepo.findByReference ? await this.txRepo.findByReference(transactionId) : null) ||
            await this.txRepo.findByTransactionId(transactionId);

        // If we have a local transaction and it's already APPROVED, return it immediately.
        if (tx && tx.status === 'APPROVED') {
            return Result.ok({
                status: tx.status,
                reference: tx.transaction_id || tx.external_reference || transactionId,
            });
        }

        // If local is PENDING (or missing but should be there), Query Wompi directly.
        // This acts as a fallback if the webhook hasn't arrived yet (race condition fix).
        try {
            const wompiStatus = await this.gateway.getTransactionStatus(transactionId);

            // If Wompi says APPROVED, verify/update our DB state immediately.
            // This ensures the frontend doesn't see "APPROVED" while the backend still thinks "PENDING".
            if (wompiStatus && wompiStatus.status === 'APPROVED') {
                // Reuse webhook logic to update DB and grant access (DRY)
                // We wrap it in a pseudo-webhook payload structure
                const payload = { data: { transaction: wompiStatus } };
                await this.handleWebhook(payload);

                return Result.ok(wompiStatus);
            }

            return Result.ok(wompiStatus);
        } catch (e) {
            // If Wompi fails, return the pending local state if we have it
            if (tx) {
                return Result.ok({ status: tx.status, reference: transactionId });
            }
            return Result.ok({ status: 'pending', reference: transactionId });
        }
    }

    /**
     * Handle Wompi webhook update.
     * CRITICAL: This is the ONLY path that marks transactions as APPROVED
     * and grants course access.
     * Supports multiple Wompi payload formats.
     */
    async handleWebhook(payload) {
        // 1. Sanitized Logging (PII Protection)
        const sensitiveKeys = /email|phone|name|token|device|browser|ip|address|details|customer_data/i;
        const safeLog = JSON.stringify(payload, (k, v) => sensitiveKeys.test(k) ? '[REDACTED_PII]' : v, 2);
        console.log('📥 [PaymentDomainService] Webhook received (Sanitized):', safeLog);

        // 2. VERIFICAR FIRMA DE SEGURIDAD (Wompi Integrity)
        if (this.gateway.verifyWebhookSignature) {
            const isValid = this.gateway.verifyWebhookSignature(payload);
            if (!isValid) {
                console.error('❌ Webhook Signature Verification FAILED. Ignoring request.');
                return Result.fail(new ValidationError('Firma inválida del webhook'));
            }
            console.log('✅ Webhook Signature Verified');
        } else {
            console.warn('⚠️ Gateway does not support signature verification or method missing');
        }

        // 3. Verificar Timestamp (Prevención de Replay Attacks)
        const timestamp = payload?.timestamp || payload?.event?.timestamp;
        if (timestamp) {
            const nowSeconds = Math.floor(Date.now() / 1000);
            const diff = Math.abs(nowSeconds - timestamp);
            if (diff > 900) {
                console.error(`❌ Security Alert: Webhook timestamp too old. Server=${nowSeconds}, Webhook=${timestamp}`);
                return Result.fail(new ValidationError('Timestamp expirado'));
            }
        }

        // Extract transaction from various Wompi payload structures
        let transaction = null;

        // Format 1: { event: { data: { transaction: {...} } } }
        if (payload?.event?.data?.transaction) {
            transaction = payload.event.data.transaction;
        }
        // Format 2: { data: { transaction: {...} } }
        else if (payload?.data?.transaction) {
            transaction = payload.data.transaction;
        }
        // Format 3: { transaction: {...} }
        else if (payload?.transaction) {
            transaction = payload.transaction;
        }
        // Format 4: Direct transaction object
        else if (payload?.id && payload?.status) {
            transaction = payload;
        }

        if (!transaction) {
            console.error('❌ Webhook: Could not extract transaction from payload');
            return Result.fail(new ValidationError('Webhook inválido: no se encontró transacción'));
        }

        const wompiStatus = transaction.status;
        const reference = transaction.reference || null;
        const wompiTransactionId = transaction.id;
        const amountInCents = transaction.amount_in_cents;

        console.log(`💳 Processing: Ref=${reference}, Status=${wompiStatus}, Amount=${amountInCents}`);

        const dbStatus = wompiStatus === 'APPROVED' ? 'APPROVED' :
            wompiStatus === 'DECLINED' ? 'DECLINED' :
            wompiStatus === 'VOIDED' ? 'VOIDED' :
            wompiStatus === 'ERROR' ? 'FAILED' :
            'PENDING';

        // 4. Buscar Transacción (Validación cruzada)
        let tx = null;
        let userId = null;
        let courseId = null;

        if (reference) {
            try {
                const finder = this.txRepo.findByReference ? 
                               this.txRepo.findByReference.bind(this.txRepo) : 
                               this.txRepo.findByTransactionId.bind(this.txRepo);
                tx = await finder(reference);
            } catch (e) {
                console.warn(`Query error searching for ${reference}:`, e);
            }
        }

        // 5. Validar Monto (Prevención de manipulación)
        if (tx && amountInCents && dbStatus === 'APPROVED') {
             const expectedAmountCents = Math.round((tx.amount || 0) * 100);
             if (Math.abs(expectedAmountCents - amountInCents) > 10000) { 
                 console.error(`❌ FRAUD ALERT: Amount mismatch. Expected ${expectedAmountCents}, Got ${amountInCents}`);
                 return Result.fail(new ValidationError('Seguridad: El monto no coincide'));
             }
        }
        
        // 6. Actualizar
        if (reference) {
            // Log sanitizado
            const safeGatewayResponse = JSON.stringify(transaction, (k, v) => /email|phone|name|token|device/i.test(k) ? '[REDACTED]' : v);
            
            try {
                if (this.txRepo.updateByReference) {
                    await this.txRepo.updateByReference(reference, {
                        status: dbStatus,
                        gatewayResponse: safeGatewayResponse,
                        wompiTransactionId: wompiTransactionId,
                    });
                } else {
                    await this.txRepo.updateByTransactionId(reference, {
                        status: dbStatus,
                        gatewayResponse: safeGatewayResponse,
                    });
                }
                console.log(`✅ Transaction ${reference} updated to ${dbStatus}`);
            } catch (e) {
                console.warn(`⚠️ Could not update by transaction_id=${reference}: ${e.message}`);
            }
            
            // Extract IDs for access grant
            userId = tx?.user_id;
            courseId = tx?.course_id;

             // If not in DB TX, parse from reference
            if ((!userId || !courseId) && reference) {
                const parts = reference.split('-');
                if (parts.length >= 3 && parts[0] === 'CV') {
                    userId = parseInt(parts[1]);
                    courseId = parseInt(parts[2]);
                } else if (reference.startsWith('ORDER_')) {
                    const orderParts = reference.split('_');
                    if (orderParts.length >= 4) {
                        userId = parseInt(orderParts[2]);
                        courseId = parseInt(orderParts[3]);
                    }
                }
            }
            
            if (dbStatus === 'APPROVED' && userId && courseId) {
                await this._grantCourseAccess(userId, courseId);
                console.log(`🎉 Payment APPROVED. Access granted to User ${userId} for Course ${courseId}`);
            }
        }

        // If no reference match, try amount-based matching for VPOS transactions
        if ((!userId || !courseId) && dbStatus === 'APPROVED' && amountInCents) {
            console.log('⚠️ VPOS/no-reference transaction. Attempting amount-based matching...');
            const amountInPesos = amountInCents / 100;
            const pendingTxs = (this.txRepo.findPendingByAmount ? await this.txRepo.findPendingByAmount(amountInPesos) : []) || [];

            for (const pendingTx of pendingTxs) {
                // Extract user/course from the stored reference (could be in transaction_id or external_reference)
                const ref = pendingTx.transaction_id || pendingTx.external_reference;
                if (ref) {
                    let txUserId = null,
                        txCourseId = null;
                    const parts = ref.split('-');
                    if (parts.length >= 3 && parts[0] === 'CV') {
                        txUserId = parseInt(parts[1]);
                        txCourseId = parseInt(parts[2]);
                    } else if (ref.startsWith('ORDER_')) {
                        const orderParts = ref.split('_');
                        if (orderParts.length >= 4) {
                            txUserId = parseInt(orderParts[2]);
                            txCourseId = parseInt(orderParts[3]);
                        }
                    }
                    if (!txUserId || !txCourseId) {
                        txUserId = pendingTx.user_id;
                        txCourseId = pendingTx.course_id;
                    }
                    if (txUserId && txCourseId) {
                        userId = txUserId;
                        courseId = txCourseId;
                        // Claim this transaction
                        await this.txRepo.update(pendingTx.id, {
                            status: dbStatus,
                            gatewayResponse: JSON.stringify(transaction),
                        });
                        console.log(`✅ VPOS transaction claimed for user ${userId}, course ${courseId}`);
                        break;
                    }
                } else if (pendingTx.user_id && pendingTx.course_id) {
                    userId = pendingTx.user_id;
                    courseId = pendingTx.course_id;
                    await this.txRepo.update(pendingTx.id, {
                        status: dbStatus,
                        gatewayResponse: JSON.stringify(transaction),
                    });
                    console.log(`✅ VPOS transaction claimed (by DB fields) for user ${userId}, course ${courseId}`);
                    break;
                }
            }
        }

        // If APPROVED, grant course access and persist outbox event
        if (dbStatus === 'APPROVED' && userId && courseId) {
            await this._grantCourseAccess(userId, courseId);
            // Persist event in outbox for reliable async processing
            if (this.outboxRepo) {
                try {
                    await this.outboxRepo.insert({
                        eventType: 'PaymentConfirmed',
                        payload: { userId, courseId, reference, wompiTransactionId },
                    });
                } catch (outboxErr) {
                    console.error(`⚠️ Outbox insert failed (non-blocking): ${outboxErr.message}`);
                }
            }
            console.log(`🎉 Payment APPROVED. Access granted to User ${userId} for Course ${courseId}`);
        }

        return Result.ok({ status: dbStatus, reference, wompiTransactionId });
    }

    /**
     * Grant course access by inserting into progreso_estudiante.
     * This enrolls the user in the course after successful payment.
     */
    async _grantCourseAccess(userId, courseId) {
        try {
            if (this.progressRepo) {
                await this.progressRepo.upsert({
                    userId: userId,
                    courseId: courseId,
                    completedTasks: 0,
                    totalTasks: 0,
                    progressPercentage: 0,
                });
                console.log(`✅ Course access granted: user=${userId}, course=${courseId}`);
            } else {
                console.warn('⚠️ progressRepo not available — cannot grant course access');
            }
        } catch (error) {
            console.error(`❌ Error granting course access: ${error.message}`);
        }
    }

    async getUserTransactions(userId) {
        const txs = await this.txRepo.findByUser(userId);
        return Result.ok(txs);
    }

    async getBanks() {
        const banks = await this.gateway.getBanks();
        return Result.ok(banks);
    }

    async hasPurchasedCourse(userId, courseId) {
        const purchased = await this.txRepo.hasSuccessfulPurchase(userId, courseId);
        return Result.ok(purchased);
    }

    async getCourseTransactions(courseId) {
        const txs = this.txRepo.findByCourse ?
            await this.txRepo.findByCourse(courseId) : [];
        return Result.ok(txs || []);
    }
}

export default PaymentDomainService;

