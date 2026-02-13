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

    /**
     * POST /videos/upload
     * Multipart upload: receives video file + optional thumbnail + JSON metadata.
     * All storage operations happen server-side — the client never touches R2.
     */
    uploadAndCreate = async(req, res, next) => {
        try {
            const videoFile = req.files ?.video ?.[0] || req.file;
            if (!videoFile) {
                return res.status(400).json({ success: false, error: 'Video file is required (field name: video)' });
            }

            const thumbnailFile = req.files ?.thumbnail ?.[0] || null;

            // Parse metadata from body (may come as JSON string or flat fields)
            let metadata;
            if (req.body.metadata) {
                metadata = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata;
            } else {
                metadata = {
                    title: req.body.title,
                    description: req.body.description,
                    isPaid: req.body.isPaid === 'true' || req.body.isPaid === true,
                    price: req.body.price ? parseFloat(req.body.price) : null,
                    courseId: req.body.courseId ? parseInt(req.body.courseId) : null,
                    timestamp: req.body.timestamp ? parseInt(req.body.timestamp) : Date.now(),
                };
            }

            const result = await this.videoService.uploadAndCreate({
                videoBuffer: videoFile.buffer,
                videoFilename: videoFile.originalname,
                videoMimeType: videoFile.mimetype,
                thumbnailBuffer: thumbnailFile ?.buffer || null,
                thumbnailFilename: thumbnailFile ?.originalname || null,
                thumbnailMimeType: thumbnailFile ?.mimetype || null,
                metadata,
                userId: req.user.userId,
            });

            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default VideoController;
