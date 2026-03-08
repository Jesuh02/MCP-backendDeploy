import { BaseController } from './BaseController.js';
import { createCommentSchema, updateCommentSchema } from '../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../shared/errors/index.js';
import { parsePagination } from '../../shared/pagination.js';

export class CommentController extends BaseController {
    constructor({ commentService }) {
        super();
        this.commentService = commentService;
    }

    getByVideo = async(req, res, next) => {
        const pg = parsePagination(req.query);
        this.store(req, res, next, () => this.commentService.getByVideo(parseInt(req.params.videoId), pg));
    };

    create = async(req, res, next) => {
        const { error, value } = createCommentSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        value.userId = req.user.userId;
        value.username = req.user.username;
        this.handleResult(res, next, (async() => {
            const result = await this.commentService.create(value);
            if (result.isFail()) return result;
            res.status(201);
            return result;
        })());
    };

    update = async(req, res, next) => {
        const { error, value } = updateCommentSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.commentService.update(parseInt(req.params.id), value, req.user.userId));
    };

    delete = async(req, res, next) => {
        this.store(req, res, next, () => this.commentService.delete(parseInt(req.params.id), req.user.userId));
    };

    getCount = async(req, res, next) => {
        this.store(req, res, next, () => this.commentService.getCount(parseInt(req.params.videoId)));
    };
}
export default CommentController;

