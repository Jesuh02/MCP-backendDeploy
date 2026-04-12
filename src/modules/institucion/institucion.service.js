import { Result } from '../../shared/Result.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../shared/errors/index.js';
import { generateBillingPaymentEmailHTML } from '../../templates/emailTemplates.js';

export class InstitucionDomainService {
    constructor({ institucionRepository, transactionRepository, paymentGatewayPort, userRepository }) {
        this.repo = institucionRepository;
        this.txRepo = transactionRepository || null;
        this.gateway = paymentGatewayPort || null;
        this.userRepo = userRepository || null;
        this.notificationService = null;
    }

    setNotificationService(notifService) {
        this.notificationService = notifService;
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

    /**
     * Set billing cycle for an institution.
     * @param {number} institutionId
     * @param {object} cycle
     * @param {'monthly_start'|'biweekly'|'monthly_day'} cycle.type
     * @param {number|null} cycle.day - Day of month (1-28) for 'monthly_day'
     * @param {number} [cycle.hour=8] - Hour of day (0-23) when billing triggers
     */
    async setBillingCycle(institutionId, { type, day, hour = 8, minute = 0, months, billing_action_mode = 'warning' }) {
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.fail(new NotFoundError('Institucion', institutionId));

        const validTypes = ['monthly_start', 'biweekly', 'monthly_day', 'specific_months'];
        if (!validTypes.includes(type)) {
            return Result.fail(new ValidationError(`Tipo de ciclo inválido. Valores válidos: ${validTypes.join(', ')}`));
        }
        if (type === 'monthly_day' || type === 'specific_months') {
            const d = parseInt(day);
            if (!d || d < 1 || d > 28) {
                return Result.fail(new ValidationError('El día debe ser entre 1 y 28'));
            }
        }

        const safeHour = Math.min(23, Math.max(0, parseInt(hour) || 8));
        const safeMinute = Math.min(59, Math.max(0, parseInt(minute) || 0));
        const nextDueDate = this._computeNextDueDate(type === 'specific_months' ? 'monthly_day' : type, day, safeHour, safeMinute);
        const cycleData = {
            billing_cycle_type: type,
            billing_cycle_day: type === 'monthly_day' || type === 'specific_months' ? parseInt(day) : (type === 'biweekly' ? 15 : 1),
            billing_cycle_hour: safeHour,
            billing_cycle_minute: safeMinute,
            billing_action_mode: billing_action_mode || 'warning',
            payment_due_date: nextDueDate.toISOString(),
        };
        if (Array.isArray(months)) {
            cycleData.billing_cycle_months = months;
        }
        const updated = await this.repo.setBillingCycle(institutionId, cycleData);
        return Result.ok(updated);
    }

    async clearBillingCycle(institutionId) {
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.fail(new NotFoundError('Institucion', institutionId));
        const updated = await this.repo.clearBillingCycle(institutionId);
        return Result.ok(updated);
    }

    /**
     * Compute the next payment due date based on cycle type.
     * @param {'monthly_start'|'biweekly'|'monthly_day'} type
     * @param {number|null} day
     * @param {number} [hour=8]
     * @param {number} [minute=0]
     * @returns {Date}
     */
    _computeNextDueDate(type, day, hour = 8, minute = 0) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const today = now.getDate();
        const safeHour = Math.min(23, Math.max(0, parseInt(hour) || 8));
        const safeMinute = Math.min(59, Math.max(0, parseInt(minute) || 0));

        const setTime = (d) => { d.setHours(safeHour, safeMinute, 0, 0); return d; };

        if (type === 'monthly_start') {
            // Next 1st of month
            if (today >= 1) return setTime(new Date(year, month + 1, 1));
            return setTime(new Date(year, month, 1));
        }

        if (type === 'biweekly') {
            // Next 1st or 15th
            if (today < 15) return setTime(new Date(year, month, 15));
            return setTime(new Date(year, month + 1, 1));
        }

        if (type === 'monthly_day') {
            const d = parseInt(day) || 1;
            if (today < d) return setTime(new Date(year, month, d));
            return setTime(new Date(year, month + 1, d));
        }

        return setTime(new Date(year, month + 1, 1));
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

    /** Set the monthly price (COP) for an institution. */
    async setMonthlyPrice(institutionId, price) {
        const item = await this.repo.findById(institutionId);
        if (!item) return Result.fail(new NotFoundError('Institucion', institutionId));
        const numPrice = parseFloat(price);
        if (isNaN(numPrice) || numPrice < 0) return Result.fail(new ValidationError('Precio inválido'));
        const updated = await this.repo.update(institutionId, { monthly_price: numPrice });
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
                institutionId,
            });
        }
        const isOverdue = item.payment_due_date && new Date(item.payment_due_date) < new Date();
        return Result.ok({
            allowed: true,
            paymentOverdue: isOverdue,
            paymentDueDate: item.payment_due_date,
            institutionId,
        });
    }

    /** Find institutions with overdue payments. */
    async findOverduePayment() {
        const items = await this.repo.findOverduePayment();
        return Result.ok(items);
    }

    // ═══════════════════════════════════════════════════════
    // Institution billing payments (Wompi via transactions table)
    // ═══════════════════════════════════════════════════════

    /**
     * Public billing payment for suspended institutions.
     * Uses the institution's monthly_price. No auth required.
     * Resolves an admin user (role 3) from the institution to satisfy the
     * NOT NULL constraint on transactions.user_id.
     */
    async initiatePublicBillingPayment({ institutionId, redirectUrl }) {
        if (!this.txRepo) return Result.fail(new ValidationError('Transaction repository not available'));
        if (!this.gateway) return Result.fail(new ValidationError('Payment gateway not available'));

        const inst = await this.repo.findById(institutionId);
        if (!inst) return Result.fail(new NotFoundError('Institucion', institutionId));
        if (!inst.is_suspended) return Result.fail(new ValidationError('La institución no está suspendida'));

        const price = inst.monthly_price || 0;
        if (price <= 0) return Result.fail(new ValidationError('La institución no tiene un precio mensual configurado'));

        // Resolve an admin user_id for this institution so the transaction
        // satisfies the NOT NULL constraint on user_id.
        let adminUserId = null;
        if (this.userRepo) {
            try {
                adminUserId = await this._findAdminUserForInstitution(institutionId);
            } catch { /* non-fatal */ }
        }

        return this.initiateBillingPayment({
            institutionId,
            userId: adminUserId,
            amount: price,
            redirectUrl,
        });
    }

    /**
     * Finds the first admin user (role 3) that belongs to the given institution.
     * Queries: usuarios_roles → usuarios → personas.institucion_id.
     * @returns {Promise<number|null>}
     */
    async _findAdminUserForInstitution(institutionId) {
        if (!this.userRepo?.client) return null;
        const { data, error } = await this.userRepo.client
            .from('usuarios_roles')
            .select('usuario_id, usuarios!inner(id, persona_id, personas!inner(institucion_id))')
            .eq('rol_id', 3)
            .eq('usuarios.personas.institucion_id', institutionId)
            .order('usuario_id', { ascending: true })
            .limit(1);
        if (error || !data?.length) return null;
        return data[0].usuario_id;
    }

    /** Initiate a billing payment for an institution (stored as payment_type='service' in transactions). */
    async initiateBillingPayment({ institutionId, userId, amount, redirectUrl }) {
        if (!this.txRepo) return Result.fail(new ValidationError('Transaction repository not available'));
        if (!this.gateway) return Result.fail(new ValidationError('Payment gateway not available'));

        const inst = await this.repo.findById(institutionId);
        if (!inst) return Result.fail(new NotFoundError('Institucion', institutionId));

        const amountInCents = Math.round(Number(amount) * 100);
        if (amountInCents <= 0) return Result.fail(new ValidationError('Monto inválido'));

        // Prevent duplicate: if this user+institution already has an APPROVED service payment
        // for the current billing period, reject.
        if (this.txRepo.hasApprovedServicePayment) {
            const alreadyPaid = await this.txRepo.hasApprovedServicePayment(institutionId, userId);
            if (alreadyPaid && !inst.is_suspended) {
                return Result.fail(new ValidationError('Ya existe un pago aprobado para esta institución'));
            }
        }

        const reference = `INST-${institutionId}-${Date.now()}`;
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        // Reuse pending service payment if exists (same institution + user)
        let payment = await this.txRepo.findPendingServicePayment(institutionId, userId);
        if (payment) {
            payment = await this.txRepo.update(payment.id, {
                externalReference: reference,
                amount,
            });
        } else {
            payment = await this.txRepo.createServicePayment({
                institutionId,
                amount,
                currency: 'COP',
                status: 'PENDING',
                paymentMethod: 'wompi',
                externalReference: reference,
                userId,
                billingPeriodStart: now.toISOString(),
                billingPeriodEnd: periodEnd.toISOString(),
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

    /** Handle Wompi webhook for institution billing (payment_type='service'). */
    async handleBillingWebhook(payload) {
        let transaction = payload?.data?.transaction || payload?.event?.data?.transaction || payload?.transaction;
        if (!transaction) return Result.fail(new ValidationError('Webhook inválido'));

        const reference = transaction.reference || null;
        const status = transaction.status;
        if (!reference || !reference.startsWith('INST-')) return Result.ok({ handled: false });

        if (!this.txRepo) return Result.ok({ handled: false });
        const payment = await this.txRepo.findByReference(reference);
        if (!payment) return Result.ok({ handled: false });

        const dbStatus = status === 'APPROVED' ? 'APPROVED' :
            status === 'DECLINED' ? 'DECLINED' : 'PENDING';

        await this.txRepo.update(payment.id, {
            status: dbStatus,
            wompiTransactionId: transaction.id,
        });

        if (dbStatus === 'APPROVED') {
            const instId = payment.institution_id;
            const inst = await this.repo.findById(instId);

            // Compute next due date from billing cycle if configured, otherwise +1 month
            let newDueDate;
            if (inst && inst.billing_cycle_type) {
                newDueDate = this._computeNextDueDate(
                    inst.billing_cycle_type,
                    inst.billing_cycle_day,
                    inst.billing_cycle_hour ?? 8,
                    inst.billing_cycle_minute ?? 0
                );
            } else {
                newDueDate = new Date();
                newDueDate.setMonth(newDueDate.getMonth() + 1);
            }
            await this.repo.setPaymentDueDate(instId, newDueDate.toISOString());

            // Unsuspend if was suspended (payment clears the suspension)
            if (inst && inst.is_suspended) {
                await this.repo.unsuspend(instId);
                console.log(`🏛️ Institution ${instId} UNSUSPENDED — all users now have access`);
            }
            console.log(`🏛️ Institution ${instId} payment APPROVED. Due extended to ${newDueDate.toISOString()}`);

            // Send payment confirmation email with invoice to the user who paid
            if (this.notificationService && payment.user_id) {
                try {
                    let payerName = 'Usuario';
                    if (this.userRepo) {
                        const payer = await this.userRepo.findById(payment.user_id);
                        if (payer?.username) payerName = payer.username;
                    }
                    const emailHtml = generateBillingPaymentEmailHTML({
                        userName: payerName,
                        institutionName: inst?.nombre || 'Institución',
                        amount: payment.amount || 0,
                        currency: payment.currency || 'COP',
                        reference: payment.external_reference || reference,
                        paymentDate: new Date().toISOString(),
                        billingPeriodStart: payment.billing_period_start,
                        billingPeriodEnd: payment.billing_period_end,
                        transactionId: transaction.id || '',
                    });
                    await this.notificationService.sendEmail(payment.user_id, {
                        subject: `✅ Pago confirmado — ${inst?.nombre || 'Institución'}`,
                        html: emailHtml,
                        text: `Tu pago de ${payment.amount} ${payment.currency || 'COP'} por ${inst?.nombre || 'la institución'} ha sido aprobado. Referencia: ${reference}`,
                    });
                    console.log(`📧 Billing payment email sent to userId ${payment.user_id}`);
                } catch (emailErr) {
                    console.error('⚠️ Failed to send billing payment email:', emailErr.message);
                }
            }
        }

        return Result.ok({ handled: true, status: dbStatus });
    }

    /** Get billing payments for an institution (payment_type='service'). */
    async getBillingPayments(institutionId) {
        if (!this.txRepo) return Result.ok([]);
        const payments = await this.txRepo.findServicePaymentsByInstitution(institutionId);
        return Result.ok(payments);
    }

    /** Get ALL service payments across all institutions (superadmin). */
    async getAllServicePayments() {
        if (!this.txRepo) return Result.ok([]);
        const payments = await this.txRepo.findAllServicePayments();
        return Result.ok(payments);
    }

    /**
     * Automatically suspend institutions whose payment_due_date has passed
     * and whose billing_action_mode is 'suspension'. Called by the scheduler every minute.
     */
    async autoProcessOverdueActions() {
        if (!this.repo.findForAutoSuspension) return Result.ok({ processed: 0 });
        try {
            const institutions = await this.repo.findForAutoSuspension();
            let processed = 0;
            for (const inst of institutions) {
                try {
                    await this.repo.suspend(inst.id, 'Pago vencido — suspensión automática programada');
                    console.log(`🏛️ Auto-suspended institution ${inst.id} (${inst.nombre}) — due date ${inst.payment_due_date} passed`);
                    processed++;
                } catch (err) {
                    console.error(`⚠️ Failed to auto-suspend institution ${inst.id}:`, err.message);
                }
            }
            return Result.ok({ processed });
        } catch (err) {
            console.error('⚠️ autoProcessOverdueActions error:', err.message);
            return Result.fail(err);
        }
    }
}
export default InstitucionDomainService;
