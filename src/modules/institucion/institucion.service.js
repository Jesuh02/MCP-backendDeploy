import { Result } from '../../shared/Result.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../shared/errors/index.js';

export class InstitucionDomainService {
    constructor({ institucionRepository, institutionPaymentRepository, paymentGatewayPort, userRepository }) {
        this.repo = institucionRepository;
        this.paymentRepo = institutionPaymentRepository || null;
        this.gateway = paymentGatewayPort || null;
        this.userRepo = userRepository || null;
    }

    async getById(id) {
        const item = await this.repo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Institucion', id));
        return Result.ok(item);
    }

    async list(pagination = {}) {
        const items = await this.repo.findAll(pagination);
        return Result.ok(items);
    }

    /** List ALL institutions including inactive/suspended (for superadmin). */
    async listAll(pagination = {}) {
        const items = await this.repo.findAllUnfiltered(pagination);
        return Result.ok(items);
    }

    async search(query, options = {}) {
        const items = await this.repo.search(query, options);
        return Result.ok(items);
    }

    async create(data) {
        const created = await this.repo.create(data);
        return Result.ok(created);
    }

    async update(id, data) {
        const item = await this.repo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Institucion', id));
        const updated = await this.repo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const item = await this.repo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Institucion', id));
        await this.repo.delete(id);
        return Result.ok({ message: 'Institución eliminada' });
    }

    // ═══════════════════════════════════════════════════════
    // SuperAdmin: Billing & Suspension
    // ═══════════════════════════════════════════════════════

    /** Set the monthly payment due date for an institution. */
    async setPaymentDueDate(institutionId, dueDate) {
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.fail(new NotFoundError('Institucion', institutionId));
        if (dueDate && isNaN(new Date(dueDate).getTime())) {
            return Result.fail(new ValidationError('Fecha de pago inválida'));
        }
        const updated = await this.repo.setPaymentDueDate(institutionId, dueDate || null);
        return Result.ok(updated);
    }

    /** Suspend an institution — blocks all logins for its users. */
    async suspend(institutionId, reason = null) {
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.fail(new NotFoundError('Institucion', institutionId));
        const updated = await this.repo.suspend(institutionId, reason);
        return Result.ok(updated);
    }

    /** Reactivate a suspended institution. */
    async unsuspend(institutionId) {
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.fail(new NotFoundError('Institucion', institutionId));
        const updated = await this.repo.unsuspend(institutionId);
        return Result.ok(updated);
    }

    /** Check if an institution is suspended (for login guards). */
    async checkInstitutionAccess(institutionId) {
        if (!institutionId) return Result.ok({ allowed: true });
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.ok({ allowed: true }); // No institution = no restriction
        if (item.is_suspended) {
            return Result.ok({
                allowed: false,
                reason: item.suspended_reason || 'Institución suspendida',
                suspended: true,
            });
        }
        const isOverdue = item.payment_due_date && new Date(item.payment_due_date) < new Date();
        return Result.ok({
            allowed: true,
            paymentOverdue: isOverdue,
            paymentDueDate: item.payment_due_date,
        });
    }

    /** Find institutions with overdue payments. */
    async findOverduePayment() {
        const items = await this.repo.findOverduePayment();
        return Result.ok(items);
    }

    // ═══════════════════════════════════════════════════════
    // Institution billing payments (Wompi)
    // ═══════════════════════════════════════════════════════

    /** Initiate a billing payment for an institution. */
    async initiateBillingPayment({ institutionId, userId, amount, redirectUrl }) {
        if (!this.paymentRepo) return Result.fail(new ValidationError('Payment repository not available'));
        if (!this.gateway) return Result.fail(new ValidationError('Payment gateway not available'));

        const inst = await this.repo.findById(institutionId);
        if (!inst) return Result.fail(new NotFoundError('Institucion', institutionId));

        const amountInCents = Math.round(Number(amount) * 100);
        if (amountInCents <= 0) return Result.fail(new ValidationError('Monto inválido'));

        const reference = `INST-${institutionId}-${Date.now()}`;
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        // Reuse pending payment if exists
        let payment = await this.paymentRepo.findPending(institutionId);
        if (payment) {
            payment = await this.paymentRepo.update(payment.id, {
                external_reference: reference,
                amount,
                paid_by_user_id: userId,
            });
        } else {
            payment = await this.paymentRepo.create({
                institution_id: institutionId,
                amount,
                currency: 'COP',
                status: 'PENDING',
                payment_method: 'wompi',
                external_reference: reference,
                paid_by_user_id: userId,
                billing_period_start: now.toISOString(),
                billing_period_end: periodEnd.toISOString(),
            });
        }

        const redirectBase = redirectUrl || 'https://mcp-backenddeploy-production-4ed0.up.railway.app/api/v1/instituciones/billing/redirect';
        const checkout = await this.gateway.initiatePayment({
            amountInCents,
            currency: 'COP',
            reference,
            redirectUrl: redirectBase,
        });

        return Result.ok({
            ...checkout,
            paymentId: payment.id,
            reference,
            amount,
            institutionName: inst.nombre,
        });
    }

    /** Handle Wompi webhook for institution billing. */
    async handleBillingWebhook(payload) {
        let transaction = payload?.data?.transaction || payload?.event?.data?.transaction || payload?.transaction;
        if (!transaction) return Result.fail(new ValidationError('Webhook inválido'));

        const reference = transaction.reference || null;
        const status = transaction.status;
        if (!reference || !reference.startsWith('INST-')) return Result.ok({ handled: false });

        const payment = await this.paymentRepo.findByReference(reference);
        if (!payment) return Result.ok({ handled: false });

        const dbStatus = status === 'APPROVED' ? 'APPROVED' :
            status === 'DECLINED' ? 'DECLINED' : 'PENDING';

        await this.paymentRepo.update(payment.id, {
            status: dbStatus,
            wompi_transaction_id: transaction.id,
        });

        if (dbStatus === 'APPROVED') {
            // Extend payment due date by one month
            const newDueDate = new Date();
            newDueDate.setMonth(newDueDate.getMonth() + 1);
            await this.repo.setPaymentDueDate(payment.institution_id, newDueDate.toISOString());
            // Unsuspend if was suspended for payment
            const inst = await this.repo.findById(payment.institution_id);
            if (inst && inst.is_suspended && inst.suspended_reason === 'Pago vencido') {
                await this.repo.unsuspend(payment.institution_id);
            }
            console.log(`🏛️ Institution ${payment.institution_id} payment APPROVED. Due extended to ${newDueDate.toISOString()}`);
        }

        return Result.ok({ handled: true, status: dbStatus });
    }

    /** Get billing payments for an institution. */
    async getBillingPayments(institutionId) {
        if (!this.paymentRepo) return Result.ok([]);
        const payments = await this.paymentRepo.findByInstitution(institutionId);
        return Result.ok(payments);
    }
}
export default InstitucionDomainService;
