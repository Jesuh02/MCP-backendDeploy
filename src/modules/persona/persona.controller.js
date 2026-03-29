/**
 * PersonaController — CRUD personas.
 */
import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';

function normalizePersonaPayload(payload = {}) {
    const normalized = { ...payload };
    const cedula = normalized.cedula ?? normalized.identificacion;
    if (cedula !== undefined) {
        normalized.cedula = cedula;
        normalized.identificacion = cedula;
    }
    return normalized;
}

const createPersonaSchema = Joi.object({
    nombres: Joi.string().min(1).max(100).required(),
    apellidos: Joi.string().max(100).allow('').optional(),
    cedula: Joi.string().max(50).allow('').optional(),
    identificacion: Joi.string().max(50).allow('').optional(),
    telefono: Joi.string().max(50).allow('').optional(),
    direccion: Joi.string().max(200).allow('').optional(),
    fecha_nacimiento: Joi.string().allow('', null).optional(),
    genero: Joi.string().max(30).allow('', null).optional(),
    institucion_id: Joi.number().integer().positive().allow(null).optional(),
});

const updatePersonaSchema = Joi.object({
    nombres: Joi.string().min(1).max(100).optional(),
    apellidos: Joi.string().max(100).allow('').optional(),
    cedula: Joi.string().max(50).allow('').optional(),
    identificacion: Joi.string().max(50).allow('').optional(),
    telefono: Joi.string().max(50).allow('').optional(),
    direccion: Joi.string().max(200).allow('').optional(),
    fecha_nacimiento: Joi.string().allow('', null).optional(),
    genero: Joi.string().max(30).allow('', null).optional(),
    institucion_id: Joi.number().integer().positive().allow(null).optional(),
}).min(1);

export class PersonaController {
    constructor({ personaService }) {
        this.personaService = personaService;
    }

    list = async(req, res, next) => {
        try {
            const result = await this.personaService.list(req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    search = async(req, res, next) => {
        try {
            const q = (req.query.q || '').trim();
            if (!q) return res.json({ success: true, data: [] });
            const limit = parseInt(req.query.limit) || 20;
            const result = await this.personaService.search(q, limit);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    byUserIds = async(req, res, next) => {
        try {
            const raw = String(req.query.userIds || '').split(',');
            const userIds = raw.map(Number).filter(n => Number.isFinite(n) && n > 0);
            if (!userIds.length) return res.json({ success: true, data: [] });
            const result = await this.personaService.getByUserIds(userIds);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.personaService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByIdentificacion = async(req, res, next) => {
        try {
            const result = await this.personaService.getByIdentificacion(req.params.identificacion);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createPersonaSchema.validate(normalizePersonaPayload(req.body));
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.personaService.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    update = async(req, res, next) => {
        try {
            const { error, value } = updatePersonaSchema.validate(normalizePersonaPayload(req.body));
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.personaService.update(parseInt(req.params.id), value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.personaService.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default PersonaController;

