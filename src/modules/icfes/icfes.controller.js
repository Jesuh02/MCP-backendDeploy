import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';

const startSchema = Joi.object({
    area: Joi.string().uppercase().valid('LC', 'MAT', 'SOC', 'CN', 'ING').required(),
});

const answerSchema = Joi.object({
    questionId: Joi.alternatives(Joi.string(), Joi.number()).required(),
    selected: Joi.string().valid('A', 'B', 'C', 'D').allow(null),
    timeMs: Joi.number().integer().min(0).max(600000).required(),
});

const submitSchema = Joi.object({
    sessionId: Joi.alternatives(Joi.string(), Joi.number()).required(),
    answers: Joi.array().items(answerSchema).min(1).max(50).required(),
});

export class IcfesController {
    constructor({ icfesService }) {
        this.svc = icfesService;
    }

    listAreas = async (_req, res, next) => {
        try {
            const r = await this.svc.listAreas();
            if (r.isFail()) return next(new Error(r.getError()));
            res.json({ success: true, data: r.getValue() });
        } catch (e) { next(e); }
    };

    start = async (req, res, next) => {
        try {
            const { error, value } = startSchema.validate(req.body || {});
            if (error) return next(ValidationError.fromJoi(error));
            const r = await this.svc.startSession(req.user.userId, value.area);
            if (r.isFail()) return res.status(409).json({ success: false, error: { code: 'ICFES_START_FAILED', message: r.getError() } });
            res.json({ success: true, data: r.getValue() });
        } catch (e) { next(e); }
    };

    submit = async (req, res, next) => {
        try {
            const { error, value } = submitSchema.validate(req.body || {});
            if (error) return next(ValidationError.fromJoi(error));
            const r = await this.svc.submitSession(req.user.userId, value);
            if (r.isFail()) return res.status(409).json({ success: false, error: { code: 'ICFES_SUBMIT_FAILED', message: r.getError() } });
            res.json({ success: true, data: r.getValue() });
        } catch (e) { next(e); }
    };

    history = async (req, res, next) => {
        try {
            const r = await this.svc.getHistory(req.user.userId);
            if (r.isFail()) return next(new Error(r.getError()));
            res.json({ success: true, data: r.getValue() });
        } catch (e) { next(e); }
    };
}

export default IcfesController;
