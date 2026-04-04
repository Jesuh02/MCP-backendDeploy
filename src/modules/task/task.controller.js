import { BaseController } from '../../shared/BaseController.js';
import { createTaskSchema, updateTaskSchema } from '../../shared/validators/CommonSchemas.js';
import { ValidationError } from '../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../shared/pagination.js';

export class TaskController extends BaseController {
    constructor({ taskService }) {
        super();
        this.taskService = taskService;
    }

    list = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.taskService.list(pg);
            if (result.isFail()) return next(result.getError());
            const { tasks, total } = result.getValue();
            const paginated = buildPaginatedResponse(tasks, total, pg.page, pg.pageSize);
            // Return raw paginated response (already structured)
            return res.json(paginated);
        } catch (err) {
            next(err);
        }
    };

    getById = async(req, res, next) => {
        this.store(req, res, next, () => this.taskService.getById(parseInt(req.params.id)));
    };

    getByTopic = async(req, res, next) => {
        this.store(req, res, next, () => this.taskService.getByTopic(parseInt(req.params.topicId)));
    };

    getByCourse = async(req, res, next) => {
        this.store(req, res, next, () => this.taskService.getByCourse(parseInt(req.params.courseId)));
    };

    getBySubject = async(req, res, next) => {
        this.store(req, res, next, () => this.taskService.getBySubject(parseInt(req.params.subjectId)));
    };

    create = async(req, res, next) => {
        const { error, value } = createTaskSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.handleResult(res, next, (async() => {
            const result = await this.taskService.createAndNotify(value, req.user?.userId, req.user);
            if (result.isFail()) return result;
            res.status(201);
            return result;
        })());
    };

    update = async(req, res, next) => {
        const { error, value } = updateTaskSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.taskService.updateAndNotify(parseInt(req.params.id), value, req.user?.userId, req.user));
    };

    delete = async(req, res, next) => {
        this.store(req, res, next, () => this.taskService.delete(parseInt(req.params.id), req.user?.userId));
    };
}
export default TaskController;

