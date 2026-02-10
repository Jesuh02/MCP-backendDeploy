import { createSubmissionSchema, gradeSubmissionSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination } from '../../../shared/pagination.js';

export class SubmissionController {
    constructor({ submissionService }) {
        this.subService = submissionService;
    }

    getById = async(req, res, next) => {
        try {
            const result = await this.subService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByTask = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subService.getByTask(parseInt(req.params.taskId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMySubmissions = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subService.getByUser(req.user.userId, pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    submit = async(req, res, next) => {
        try {
            const { error, value } = createSubmissionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            value.userId = req.user.userId;
            value.username = req.user.username;
            const result = await this.subService.submit(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    grade = async(req, res, next) => {
        try {
            const { error, value } = gradeSubmissionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.subService.grade(parseInt(req.params.id), value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.subService.delete(parseInt(req.params.id), req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByUserAndTask = async(req, res, next) => {
        try {
            const taskId = parseInt(req.params.taskId);
            const studentId = req.query.studentId ? parseInt(req.query.studentId) : req.user.userId;
            const result = await this.subService.getByUserAndTask(studentId, taskId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subService.getByCourse(parseInt(req.params.courseId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default SubmissionController;