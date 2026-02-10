import { createCommentSchema, updateCommentSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination } from '../../../shared/pagination.js';

export class CommentController {
    constructor({ commentService }) {
        this.commentService = commentService;
    }

    getByVideo = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.commentService.getByVideo(parseInt(req.params.videoId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createCommentSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            value.userId = req.user.userId;
            value.username = req.user.username;
            const result = await this.commentService.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    update = async(req, res, next) => {
        try {
            const { error, value } = updateCommentSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.commentService.update(parseInt(req.params.id), value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.commentService.delete(parseInt(req.params.id), req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getCount = async(req, res, next) => {
        try {
            const result = await this.commentService.getCount(parseInt(req.params.videoId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default CommentController;