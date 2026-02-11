import { createVideoSchema, updateVideoSchema } from '../../../domain/validators/VideoSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../../shared/pagination.js';

export class VideoController {
    constructor({ videoService }) {
        this.videoService = videoService;
    }

    list = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.videoService.list(pg);
            if (result.isFail()) return next(result.getError());
            const { videos, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(videos, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.videoService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    getByCreator = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.videoService.findByCreator(req.params.username, pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCreatorId = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.videoService.findByCreatorId(parseInt(req.params.userId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.videoService.findByCourse(parseInt(req.params.courseId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    search = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.videoService.search(req.query.q || '', pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createVideoSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            value.userId = req.user.userId;
            const result = await this.videoService.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    update = async(req, res, next) => {
        try {
            const { error, value } = updateVideoSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.videoService.update(parseInt(req.params.id), value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.videoService.delete(parseInt(req.params.id), req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourseIds = async(req, res, next) => {
        try {
            const ids = (req.query.ids || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0);
            if (ids.length === 0) return res.json({ success: true, data: [] });
            const pg = parsePagination(req.query);
            const result = await this.videoService.findByCourseIds(ids, pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getSignedUrl = async(req, res, next) => {
        try {
            const result = await this.videoService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            const video = result.getValue();
            res.json({
                success: true,
                data: {
                    id: video.id,
                    videoUriString: video.video_uri_string || video.videoUriString,
                    thumbnailUri: video.thumbnail_uri || video.thumbnailUri
                }
            });
        } catch (err) { next(err); }
    };

    getUploadUrl = async(req, res, next) => {
        try {
            const { filename, contentType } = req.body;
            if (!filename || !contentType) {
                return res.status(400).json({ success: false, error: 'filename and contentType are required' });
            }
            const result = await this.videoService.getUploadUrl(filename, contentType);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default VideoController;