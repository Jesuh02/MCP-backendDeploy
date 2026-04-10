import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';
import { getAllTenantEntries } from '../../config/tenantRegistry.js';
import { SupabaseInstitucionRepository } from './infrastructure/supabase.institucion.repository.js';
import { SupabaseUserRepository } from '../user/infrastructure/supabase.user.repository.js';

const createSchema = Joi.object({
    nombre: Joi.string().min(2).max(200).required(),
    codigo: Joi.string().max(50).allow('', null).optional(),
    ciudad: Joi.string().max(100).allow('', null).optional(),
    departamento: Joi.string().max(100).allow('', null).optional(),
});

const updateSchema = Joi.object({
    nombre: Joi.string().min(2).max(200).optional(),
    codigo: Joi.string().max(50).allow('', null).optional(),
    ciudad: Joi.string().max(100).allow('', null).optional(),
    departamento: Joi.string().max(100).allow('', null).optional(),
    is_active: Joi.boolean().optional(),
}).min(1);

export class InstitucionController {
    constructor({ institucionService, userRepository }) {
        this.service = institucionService;
        this.userRepo = userRepository || null;
    }

    list = async (req, res, next) => {
        try {
            const result = await this.service.list(req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    search = async (req, res, next) => {
        try {
            const { q } = req.query;
            if (!q || q.length < 1) {
                const result = await this.service.list({ limit: 20 });
                if (result.isFail()) return next(result.getError());
                return res.json({ success: true, data: result.getValue() });
            }
            const result = await this.service.search(q, { limit: 20 });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async (req, res, next) => {
        try {
            const result = await this.service.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async (req, res, next) => {
        try {
            const { error, value } = createSchema.validate(req.body);
            if (error) return next(new ValidationError(error.details[0].message));
            const result = await this.service.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    update = async (req, res, next) => {
        try {
            const { error, value } = updateSchema.validate(req.body);
            if (error) return next(new ValidationError(error.details[0].message));
            const result = await this.service.update(parseInt(req.params.id), value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async (req, res, next) => {
        try {
            const result = await this.service.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * Returns the current user's institution billing status.
     * Used by the frontend to show the payment-overdue banner.
     */
    myInstitutionStatus = async (req, res, next) => {
        try {
            const userId = req.user?.userId;
            if (!userId) return res.json({ success: true, data: { allowed: true } });

            if (!this.userRepo) return res.json({ success: true, data: { allowed: true } });
            const user = await this.userRepo.findById(userId);
            const persona = user?.persona ?? user?.personas ?? null;
            const instId = persona?.institucion_id ?? null;
            if (!instId) return res.json({ success: true, data: { allowed: true } });

            const result = await this.service.checkInstitutionAccess(instId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * Searches a username across ALL tenant databases and returns which
     * institutions the user belongs to.  Used by the chat "¿En cuántas
     * instituciones estoy?" feature.
     */
    lookupUserAcrossTenants = async (req, res, next) => {
        try {
            const username = req.params.username;
            if (!username || username.trim().length < 1) {
                return next(new ValidationError('Se requiere un username'));
            }
            const entries = getAllTenantEntries();
            const results = await Promise.allSettled(
                entries.map(async (entry) => {
                    if (!entry.client) return null;
                    const repo = new SupabaseUserRepository(entry.client);
                    const user = await repo.findByUsername(username.trim());
                    if (!user) return null;
                    return {
                        tenantId: entry.id,
                        tenantName: entry.name,
                        username: user.username,
                        roles: (user.roles || []).map(r => r.nombre || r.name || r.id || r),
                    };
                }),
            );
            const found = results
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => r.value);
            res.json({
                success: true,
                data: {
                    username: username.trim(),
                    totalInstitutions: found.length,
                    institutions: found,
                },
            });
        } catch (err) { next(err); }
    };

    /**
     * Returns institutions from ALL registered tenants, each tagged with tenantId.
     * Used by registration forms to let the user pick their institution regardless
     * of which Supabase project it lives in.
     */
    listAllTenants = async (req, res, next) => {
        try {
            const entries = getAllTenantEntries();
            const perTenant = await Promise.all(
                entries.map(async (entry) => {
                    if (!entry.client) return [];
                    try {
                        const repo = new SupabaseInstitucionRepository(entry.client);
                        const items = await repo.findAll({ limit: 500 });
                        return items.map(inst => ({ ...inst, tenantId: entry.id }));
                    } catch {
                        return [];
                    }
                }),
            );
            // Flatten: institutions from all tenants in a single array, sorted by name
            const all = perTenant.flat().sort((a, b) => a.nombre.localeCompare(b.nombre));
            res.json({ success: true, data: all });
        } catch (err) { next(err); }
    };

    // ═══════════════════════════════════════════════════════
    // SuperAdmin endpoints (role 4)
    // ═══════════════════════════════════════════════════════

    /** List ALL institutions including suspended/inactive (superadmin). */
    listAllAdmin = async (req, res, next) => {
        try {
            const result = await this.service.listAll(req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Set payment due date for an institution. */
    setPaymentDueDate = async (req, res, next) => {
        try {
            const { payment_due_date } = req.body;
            const result = await this.service.setPaymentDueDate(parseInt(req.params.id), payment_due_date);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Suspend an institution (block all user logins). */
    suspend = async (req, res, next) => {
        try {
            const { reason } = req.body || {};
            const result = await this.service.suspend(parseInt(req.params.id), reason);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Unsuspend an institution (allow logins again). */
    unsuspend = async (req, res, next) => {
        try {
            const result = await this.service.unsuspend(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Check if an institution is accessible (for login guards). */
    checkAccess = async (req, res, next) => {
        try {
            const result = await this.service.checkInstitutionAccess(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Initiate billing payment for an institution. */
    initiateBillingPayment = async (req, res, next) => {
        try {
            const { amount, redirectUrl } = req.body;
            const userId = req.user?.userId;
            const result = await this.service.initiateBillingPayment({
                institutionId: parseInt(req.params.id),
                userId,
                amount,
                redirectUrl,
            });
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            res.json({
                success: true,
                data,
                urlBankPayment: data.checkoutUrl,
            });
        } catch (err) { next(err); }
    };

    /** Get billing payment history for an institution. */
    getBillingPayments = async (req, res, next) => {
        try {
            const result = await this.service.getBillingPayments(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Wompi webhook for institution billing. */
    billingWebhook = async (req, res, next) => {
        try {
            const result = await this.service.handleBillingWebhook(req.body);
            if (result.isFail()) return res.status(200).json({ success: false, message: result.getError().message });
            res.status(200).json({ success: true, data: result.getValue() });
        } catch (err) {
            console.error('❌ Institution billing webhook exception:', err);
            res.status(200).json({ success: false, message: err.message });
        }
    };

    /** Check institution status (public, for login pages). */
    checkInstitutionStatus = async (req, res, next) => {
        try {
            const result = await this.service.checkInstitutionAccess(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default InstitucionController;
