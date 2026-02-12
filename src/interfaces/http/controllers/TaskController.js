import { BaseController } from './BaseController.js';
import { createTaskSchema, updateTaskSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../../shared/pagination.js';

export class TaskController extends BaseController {
    constructor({ taskService }) {
        super();
        this.taskService = taskService;
    }

    list = async (req, res, next) => {
        this.handleResult(res, next, (async () => {
            const pg = parsePagination(req.query);
            const result = await this.taskService.list(pg);
            if (result.isFail()) return result;
            const { tasks, total } = result.getValue();
            const paginated = buildPaginatedResponse(tasks, total, pg.page, pg.pageSize);
            // Return raw paginated response (already structured)
            return res.json(paginated);
        })());
    };

    getById = async (req, res, next) => {
        this.store(req, res, next, () => this.taskService.getById(parseInt(req.params.id)));
    };

    getByTopic = async (req, res, next) => {
        this.store(req, res, next, () => this.taskService.getByTopic(parseInt(req.params.topicId)));
    };

    getByCourse = async (req, res, next) => {
        this.store(req, res, next, () => this.taskService.getByCourse(parseInt(req.params.courseId)));
    };

    create = async (req, res, next) => {
        const { error, value } = createTaskSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.handleResult(res, next, (async () => {
            const result = await this.taskService.createAndNotify(value, req.user);
            if (result.isFail()) return result;
            res.status(201);
            return result;
        })());
    };

    update = async (req, res, next) => {
        const { error, value } = updateTaskSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.taskService.update(parseInt(req.params.id), value));
    };

    delete = async (req, res, next) => {
        this.store(req, res, next, () => this.taskService.delete(parseInt(req.params.id)));
    };
}
export default TaskController;