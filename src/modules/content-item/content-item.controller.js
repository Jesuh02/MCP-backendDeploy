import { createContentItemSchema, updateContentItemSchema } from '../../shared/validators/CommonSchemas.js';
import { ValidationError } from '../../shared/errors/index.js';

export class ContentItemController {
    constructor({ contentItemService }) {
        this.contentService = contentItemService;
    }

    getById = async(req, res, next) => {
        try {
            const result = await this.contentService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByTask = async(req, res, next) => {
        try {
            const result = await this.contentService.getByTask(parseInt(req.params.taskId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByTopic = async(req, res, next) => {
        try {
            const result = await this.contentService.getByTopic(parseInt(req.params.topicId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async(req, res, next) => {
        try {
            const result = await this.contentService.getByCourse(parseInt(req.params.courseId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createContentItemSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.contentService.create(value, req.user?.userId, req.user);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    update = async(req, res, next) => {
        try {
            const { error, value } = updateContentItemSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.contentService.update(parseInt(req.params.id), value, req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.contentService.delete(parseInt(req.params.id), req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    deleteByTask = async(req, res, next) => {
        try {
            const result = await this.contentService.deleteByTask(parseInt(req.params.taskId), req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default ContentItemController;

