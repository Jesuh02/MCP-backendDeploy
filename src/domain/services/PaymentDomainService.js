import { Result } from '../../shared/Result.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';
import crypto from 'crypto';

export class PaymentDomainService {
    constructor({ transactionRepository, courseRepository, paymentGatewayPort }) {
        this.txRepo = transactionRepository;
        this.courseRepo = courseRepository;
        this.gateway = paymentGatewayPort;
    }

    async initiate({ userId, courseId, redirectUrl }) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        if (course.is_free) return Result.fail(new ValidationError('Este curso es gratuito'));

        const amountInCents = Math.round((course.price || 0) * 100);
        if (amountInCents <= 0) return Result.fail(new ValidationError('Precio inválido'));

        const reference = `CV-${userId}-${courseId}-${Date.now()}`;

        // Guardar tx pendiente
        const tx = await this.txRepo.create({
            userId,
            courseId,
            amount: amountInCents,
            currency: 'COP',
            status: 'pending',
            paymentMethod: 'pse',
        });

        // Generar URL de checkout
        const checkout = await this.gateway.initiatePayment({
            amountInCents,
            currency: 'COP',
            reference,
            redirectUrl,
        });

        // Actualizar con referencia
        await this.txRepo.update(tx.id, { transactionId: reference });

        return Result.ok({...checkout, transactionDbId: tx.id });
    }

    async checkStatus(transactionId) {
        const status = await this.gateway.getTransactionStatus(transactionId);
        return Result.ok(status);
    }

    async handleWebhook(payload) {
        const txData = payload.transaction || payload.data?.transaction;
        if (!txData) return Result.fail(new ValidationError('Webhook inválido'));

        const status = txData.status === 'APPROVED' ? 'approved' :
            txData.status === 'DECLINED' ? 'declined' :
            txData.status === 'VOIDED' ? 'voided' :
            'pending';

        await this.txRepo.updateByTransactionId(txData.reference, {
            status,
            gatewayResponse: JSON.stringify(txData),
        });
        return Result.ok({ status, reference: txData.reference });
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
        // Find all transactions for a course
        const { data, error } = await this.txRepo.findByCourse ?
            await this.txRepo.findByCourse(courseId) : [];
        return Result.ok(data || []);
    }
}

export default PaymentDomainService;