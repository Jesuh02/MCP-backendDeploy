/**
 * ReinforcementController — Reinforcement question history.
 */
import Joi from 'joi';
import { ValidationError } from '../../../shared/errors/index.js';

const saveSessionSchema = Joi.object({
    userId: Joi.number().integer().required(),
    courseId: Joi.number().integer().required(),
    topicId: Joi.number().integer().allow(null).optional(),
    taskId: Joi.number().integer().allow(null).optional(),
    questions: Joi.alternatives().try(
        Joi.array().items(Joi.object()),
        Joi.string()
    ).required(),
});

export class ReinforcementController {
    constructor({ reinforcementService }) {
        this.reinforcementService = reinforcementService;
    }

    saveSession = async(req, res, next) => {
        try {
            const { error, value } = saveSessionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.reinforcementService.saveSession(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getHistory = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const courseId = parseInt(req.params.courseId);
            const result = await this.reinforcementService.getHistory(userId, courseId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMySessions = async(req, res, next) => {
        try {
            const result = await this.reinforcementService.getUserSessions(req.user.userId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default ReinforcementController;