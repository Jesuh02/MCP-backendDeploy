import { createVideoSchema, updateVideoSchema, uploadVideoMetadataSchema } from './video.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../shared/pagination.js';
import { unlink } from 'fs/promises';
import { getIO } from '../../config/socketServer.js';

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

    changes = async(req, res, next) => {
        try {
            const since = req.query.since;
            if (!since) return res.status(400).json({ success: false, error: 'since parameter is required (unix ms)' });
            const result = await this.videoService.getChanges(since);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
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
            const created = result.getValue();
            const io = getIO();
            if (io) io.to('videos').emit('video:created', created);
            res.status(201).json({ success: true, data: created });
        } catch (err) { next(err); }
    };

    update = async(req, res, next) => {
        try {
            const { error, value } = updateVideoSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.videoService.update(parseInt(req.params.id), value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            const updated = result.getValue();
            const io = getIO();
            if (io) io.to('videos').emit('video:updated', updated);
            res.json({ success: true, data: updated });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const deletedId = parseInt(req.params.id);
            const result = await this.videoService.delete(deletedId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            const io = getIO();
            if (io) io.to('videos').emit('video:deleted', { id: deletedId });
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

    /**
     * POST /api/v1/videos/signed-url-by-key
     * Body: { objectKey: "videos/mi_video", expiresIn?: 3600 }
     *
     * Genera una URL firmada directamente a partir de un object key.
     * Aprovecha el cache interno (50 min TTL) para no regenerar innecesariamente.
     */
    getSignedUrlByKey = async(req, res, next) => {
        try {
            const { objectKey, expiresIn } = req.body;
            if (!objectKey) {
                return res.status(400).json({ success: false, error: 'objectKey is required' });
            }
            const result = await this.videoService.getSignedUrlByKey(objectKey, expiresIn || 3600);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
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
     * POST /videos/batch-signed-urls
     * Batch pre-sign URLs for multiple video IDs in one request.
     * Designed for mobile pre-loading: the client sends IDs of adjacent
     * videos and receives all signed URLs at once.
     *
     * Body: { videoIds: [1, 2, 3] }
     * Response: { success: true, data: { 1: { videoUrl, thumbnailUrl }, ... } }
     */
    batchSignedUrls = async(req, res, next) => {
        try {
            const { videoIds } = req.body;
            if (!Array.isArray(videoIds) || videoIds.length === 0) {
                return res.status(400).json({ success: false, error: 'videoIds array is required' });
            }
            const result = await this.videoService.batchSignedUrls(videoIds);
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
        const videoFile = req.files?.video?.[0] || req.file;
        const thumbnailFile = req.files?.thumbnail?.[0] || null;
        // Collect temp file paths for cleanup regardless of success/failure
        const tempPaths = [videoFile?.path, thumbnailFile?.path].filter(Boolean);

        const cleanupTempFiles = async () => {
            for (const p of tempPaths) {
                try { await unlink(p); } catch { /* non-fatal */ }
            }
        };

        try {
            if (!videoFile) {
                return res.status(400).json({ success: false, error: 'Video file is required (field name: video)' });
            }

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

            const { error, value } = uploadVideoMetadataSchema.validate(metadata);
            if (error) {
                await cleanupTempFiles();
                return next(ValidationError.fromJoi(error));
            }

            // Pass disk paths (not buffers) so the service can stream directly to R2
            // without loading the full video into Node.js heap → prevents OOM / 502.
            const result = await this.videoService.uploadAndCreate({
                videoPath: videoFile.path,
                videoSize: videoFile.size,
                videoFilename: videoFile.originalname,
                videoMimeType: videoFile.mimetype,
                thumbnailPath: thumbnailFile?.path || null,
                thumbnailSize: thumbnailFile?.size || null,
                thumbnailFilename: thumbnailFile?.originalname || null,
                thumbnailMimeType: thumbnailFile?.mimetype || null,
                metadata: value,
                userId: req.user.userId,
            });

            await cleanupTempFiles();

            if (result.isFail()) return next(result.getError());
            const uploaded = result.getValue();
            const io = getIO();
            if (io) io.to('videos').emit('video:created', uploaded);
            res.status(201).json({ success: true, data: uploaded });
        } catch (err) {
            await cleanupTempFiles();
            next(err);
        }
    };
}
export default VideoController;

