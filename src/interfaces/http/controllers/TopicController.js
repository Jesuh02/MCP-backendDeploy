import { createTopicSchema, updateTopicSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class TopicController {
    constructor({ topicService }) {
        this.topicService = topicService;
    }

    getByCourse = async(req, res, next) => {
        try {
            const result = await this.topicService.getByCourse(parseInt(req.params.courseId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.topicService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createTopicSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.topicService.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    update = async(req, res, next) => {
        try {
            const { error, value } = updateTopicSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.topicService.update(parseInt(req.params.id), value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.topicService.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default TopicController;