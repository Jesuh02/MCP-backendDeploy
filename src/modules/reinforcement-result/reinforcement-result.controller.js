import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';

const saveResultSchema = Joi.object({
    userId: Joi.number().integer().optional(),
    user_id: Joi.number().integer().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    topicId: Joi.number().integer().allow(null).optional(),
    topic_id: Joi.number().integer().allow(null).optional(),
    taskId: Joi.number().integer().allow(null).optional(),
    task_id: Joi.number().integer().allow(null).optional(),
    totalQuestions: Joi.number().integer().min(1).required(),
    correctAnswers: Joi.number().integer().min(0).required(),
    difficulty: Joi.string().valid('EASY', 'MEDIUM', 'INTERMEDIATE', 'HARD').optional(),
    durationSeconds: Joi.number().integer().min(0).optional(),
}).options({ allowUnknown: true });

export class ReinforcementResultController {
    constructor({ reinforcementResultService }) {
        this.service = reinforcementResultService;
    }

    save = async (req, res, next) => {
        try {
            const { error, value } = saveResultSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const normalized = {
                userId: value.userId || value.user_id || req.user?.userId || req.user?.id,
                courseId: value.courseId || value.course_id,
                topicId: value.topicId || value.topic_id || null,
                taskId: value.taskId || value.task_id || null,
                totalQuestions: value.totalQuestions,
                correctAnswers: value.correctAnswers,
                difficulty: value.difficulty || 'HARD',
                durationSeconds: value.durationSeconds || 0,
            };

            if (!normalized.userId) return next(new ValidationError('userId is required'));
            if (!normalized.courseId) return next(new ValidationError('courseId is required'));

            const result = await this.service.saveResult(normalized);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByUser = async (req, res, next) => {
        try {
            const userId = parseInt(req.params.userId) || req.user?.userId || req.user?.id;
            if (!userId) return next(new ValidationError('userId is required'));
            const result = await this.service.getByUser(userId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async (req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            if (!courseId) return next(new ValidationError('courseId is required'));
            const result = await this.service.getByCourse(courseId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMy = async (req, res, next) => {
        try {
            const userId = req.user?.userId || req.user?.id;
            if (!userId) return next(new ValidationError('Authentication required'));
            const result = await this.service.getByUser(userId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getAll = async (req, res, next) => {
        try {
            const result = await this.service.getAll(req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}

export default ReinforcementResultController;
