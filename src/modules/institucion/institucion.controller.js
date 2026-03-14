import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';

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
}
export default InstitucionController;
