/**
 * ReinforcementController — Reinforcement question history.
 */
import Joi from 'joi';
import { ValidationError } from '../../../shared/errors/index.js';

// Accept both camelCase and snake_case field names from clients
const saveSessionSchema = Joi.object({
    userId: Joi.number().integer().optional(),
    user_id: Joi.number().integer().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    topicId: Joi.number().integer().allow(null).optional(),
    topic_id: Joi.number().integer().allow(null).optional(),
    taskId: Joi.number().integer().allow(null).optional(),
    task_id: Joi.number().integer().allow(null).optional(),
    questions: Joi.alternatives().try(
        Joi.array().items(Joi.object()),
        Joi.string()
    ).required(),
}).options({ allowUnknown: true });

export class ReinforcementController {
    constructor({ reinforcementService }) {
        this.reinforcementService = reinforcementService;
    }

    saveSession = async(req, res, next) => {
        try {
            const { error, value } = saveSessionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            // Normalize snake_case → camelCase, fallback to req.user from auth middleware
            const normalized = {
                userId: value.userId || value.user_id || req.user?.userId || req.user?.id || null,
                courseId: value.courseId || value.course_id,
                topicId: value.topicId || value.topic_id || null,
                taskId: value.taskId || value.task_id || null,
                questions: value.questions,
            };

            if (!normalized.userId) {
                return next(new ValidationError('userId is required (send in body or authenticate via JWT)'));
            }
            if (!normalized.courseId) {
                return next(new ValidationError('courseId is required'));
            }

            const result = await this.reinforcementService.saveSession(normalized);
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