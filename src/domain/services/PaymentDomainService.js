import { Result } from '../../shared/Result.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';
import crypto from 'crypto';

export class PaymentDomainService {
    constructor({ transactionRepository, courseRepository, paymentGatewayPort, progressRepository }) {
        this.txRepo = transactionRepository;
        this.courseRepo = courseRepository;
        this.gateway = paymentGatewayPort;
        this.progressRepo = progressRepository || null;
    }

    async initiate({ userId, courseId, redirectUrl }) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        if (course.is_free) return Result.fail(new ValidationError('Este curso es gratuito'));

        const priceInPesos = parseFloat(course.price || 0);
        const amountInCents = Math.round(priceInPesos * 100);
        if (amountInCents <= 0) return Result.fail(new ValidationError('Precio inválido'));

        const reference = `CV-${userId}-${courseId}-${Date.now()}`;

        // Guardar tx pendiente con referencia incluida (evita round-trip extra)
        const tx = await this.txRepo.create({
            userId,
            courseId,
            amount: priceInPesos,
            currency: 'COP',
            status: 'PENDING',
            paymentMethod: 'pse',
            externalReference: reference,
        });

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
        if (tx) {
            return Result.ok({
                status: tx.status,
                reference: tx.transaction_id || tx.external_reference || transactionId,
            });
        }
        // Fallback: query Wompi directly
        try {
            const status = await this.gateway.getTransactionStatus(transactionId);
            return Result.ok(status);
        } catch (e) {
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
        console.log('📥 [PaymentDomainService] Webhook received:', JSON.stringify(payload, null, 2));

        // Extract transaction from various Wompi payload structures
        let transaction = null;

        // Format 1: { event: { data: { transaction: {...} } } }
        if (payload ? .event ? .data ? .transaction) {
            transaction = payload.event.data.transaction;
        }
        // Format 2: { data: { transaction: {...} } } — Standard Wompi webhook
        else if (payload ? .data ? .transaction) {
            transaction = payload.data.transaction;
        }
        // Format 3: { transaction: {...} }
        else if (payload ? .transaction) {
            transaction = payload.transaction;
        }
        // Format 4: Direct transaction object
        else if (payload ? .id && payload ? .status) {
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

        console.log(`💳 Webhook: ID=${wompiTransactionId}, Status=${wompiStatus}, Ref=${reference}, Amount=${amountInCents}`);

        // Map Wompi status to our DB status
        const dbStatus = wompiStatus === 'APPROVED' ? 'APPROVED' :
            wompiStatus === 'DECLINED' ? 'DECLINED' :
            wompiStatus === 'VOIDED' ? 'VOIDED' :
            wompiStatus === 'ERROR' ? 'FAILED' :
            'PENDING';

        // Try to find and update the transaction by reference
        let userId = null;
        let courseId = null;

        if (reference) {
            // Try to update by reference in either column (transaction_id or external_reference)
            try {
                if (this.txRepo.updateByReference) {
                    await this.txRepo.updateByReference(reference, {
                        status: dbStatus,
                        gatewayResponse: JSON.stringify(transaction),
                        wompiTransactionId: wompiTransactionId,
                    });
                } else {
                    await this.txRepo.updateByTransactionId(reference, {
                        status: dbStatus,
                        gatewayResponse: JSON.stringify(transaction),
                    });
                }
                console.log(`✅ Transaction ${reference} updated to ${dbStatus}`);
            } catch (e) {
                console.warn(`⚠️ Could not update by transaction_id=${reference}: ${e.message}`);
            }

            // Extract userId and courseId from reference
            // Format: CV-{userId}-{courseId}-{timestamp}
            const parts = reference.split('-');
            if (parts.length >= 3 && parts[0] === 'CV') {
                userId = parseInt(parts[1]);
                courseId = parseInt(parts[2]);
            }
            // Legacy format: ORDER_{timestamp}_{userId}_{courseId}
            else if (reference.startsWith('ORDER_')) {
                const orderParts = reference.split('_');
                if (orderParts.length >= 4) {
                    userId = parseInt(orderParts[2]);
                    courseId = parseInt(orderParts[3]);
                }
            }

            // If we couldn't parse from reference, try to find in DB
            if (!userId || !courseId) {
                const tx = this.txRepo.findByReference ?
                    await this.txRepo.findByReference(reference) :
                    await this.txRepo.findByTransactionId(reference);
                if (tx) {
                    userId = tx.user_id;
                    courseId = tx.course_id;
                }
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

        // If APPROVED, grant course access
        if (dbStatus === 'APPROVED' && userId && courseId) {
            await this._grantCourseAccess(userId, courseId);
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