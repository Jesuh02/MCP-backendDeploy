import { createTaskSchema, updateTaskSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class TaskController {
    constructor({ taskService }) {
        this.taskService = taskService;
    }

    getById = async(req, res, next) => {
        try {
            const result = await this.taskService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByTopic = async(req, res, next) => {
        try {
            const result = await this.taskService.getByTopic(parseInt(req.params.topicId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async(req, res, next) => {
        try {
            const result = await this.taskService.getByCourse(parseInt(req.params.courseId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createTaskSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.taskService.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    update = async(req, res, next) => {
        try {
            const { error, value } = updateTaskSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.taskService.update(parseInt(req.params.id), value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.taskService.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default TaskController;