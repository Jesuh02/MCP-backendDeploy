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
    constructor({ institucionService }) {
        this.service = institucionService;
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
}
export default InstitucionController;
