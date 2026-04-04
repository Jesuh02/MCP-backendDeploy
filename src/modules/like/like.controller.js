import { toggleLikeSchema } from '../../shared/validators/CommonSchemas.js';
import { ValidationError } from '../../shared/errors/index.js';

export class LikeController {
    constructor({ likeService }) {
        this.likeService = likeService;
    }

    toggle = async(req, res, next) => {
        try {
            const { error, value } = toggleLikeSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.likeService.toggle(req.user.userId, value.entityType, value.entityId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    getCount = async(req, res, next) => {
        try {
            const result = await this.likeService.getCount(req.params.entityType, parseInt(req.params.entityId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getStatus = async(req, res, next) => {
        try {
            const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
            const result = await this.likeService.getLikeStatus(req.user.userId, req.params.entityType, ids);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    checkSingle = async(req, res, next) => {
        try {
            const entityId = parseInt(req.params.entityId);
            const result = await this.likeService.getLikeStatus(req.user.userId, req.params.entityType, [entityId]);
            if (result.isFail()) return next(result.getError());
            const statusMap = result.getValue();
            const liked = statusMap[entityId] || false;
            res.json({ success: true, data: liked });
        } catch (err) { next(err); }
    };
}
export default LikeController;

