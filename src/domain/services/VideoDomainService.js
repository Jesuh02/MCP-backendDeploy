import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';
import path from 'path';

export class VideoDomainService {
    constructor({ videoRepository, fileStoragePort }) {
        this.videoRepo = videoRepository;
        this.storage = fileStoragePort || null;
    }

    /**
     * Replace public R2 URLs with signed download URLs so clients
     * can access videos/thumbnails without the bucket being public.
     */
    async _signUrls(videos) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return videos;
        const list = Array.isArray(videos) ? videos : [videos];
        await Promise.all(list.map(async(v) => {
            if (!v) return;
            try {
                // Sign video URL (skip if already signed or not an HTTP URL)
                if (v.video_uri_string || v.videoUriString) {
                    const url = v.video_uri_string || v.videoUriString;
                    if (url && url.startsWith('http') && !url.includes('X-Amz-Signature')) {
                        const key = this.storage.extractObjectKey(url);
                        if (key) {
                            const signed = await this.storage.generateDownloadUrl(key, 3600);
                            v.video_uri_string = signed;
                            v.videoUriString = signed;
                        }
                    }
                }
                // Sign thumbnail URL (skip if already signed or not an HTTP URL)
                if (v.thumbnail_uri || v.thumbnailUri) {
                    const url = v.thumbnail_uri || v.thumbnailUri;
                    if (url && url.startsWith('http') && !url.includes('X-Amz-Signature')) {
                        const key = this.storage.extractObjectKey(url);
                        if (key) {
                            const signed = await this.storage.generateDownloadUrl(key, 3600);
                            v.thumbnail_uri = signed;
                            v.thumbnailUri = signed;
                        }
                    }
                }
            } catch (e) {
                console.warn('[VideoDomainService] Error signing URL for video', v.id, e.message);
            }
        }));
        return Array.isArray(videos) ? list : list[0];
    }

    async getById(id) {
        const video = await this.videoRepo.findById(id);
        if (!video) return Result.fail(new NotFoundError('Video', id));
        await this._signUrls(video);
        return Result.ok(video);
    }

    async list(pagination) {
        const [videos, total] = await Promise.all([
            this.videoRepo.findAll(pagination),
            this.videoRepo.count({}),
        ]);
        await this._signUrls(videos);
        return Result.ok({ videos, total });
    }

    async findByCreator(username, pagination) {
        const videos = await this.videoRepo.findByCreator(username, pagination);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async findByCreatorId(userId, pagination) {
        const videos = await this.videoRepo.findByCreatorId(userId, pagination);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async findByCourse(courseId, pagination) {
        const videos = await this.videoRepo.findByCourse(courseId, pagination);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async search(query, pagination) {
        const videos = await this.videoRepo.search(query, pagination);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async getUploadUrl(filename, contentType) {
        try {
            if (!this.storage) return Result.fail(new Error("Storage service not available"));
            // Generate a unique key, sanitizing filename
            const cleanName = (filename || 'file').replace(/[^a-zA-Z0-9.-]/g, '_');
            const uniqueKey = `uploads/${Date.now()}_${cleanName}`;

            const url = await this.storage.generateUploadUrl(uniqueKey, contentType, 3600);
            return Result.ok({
                uploadUrl: url,
                publicUrl: this.storage.getPublicUrl(uniqueKey),
                key: uniqueKey
            });
        } catch (error) {
            return Result.fail(error);
        }
    }

    /**
     * Upload video + optional thumbnail files to R2 and create the video record.
     * All storage logic is centralized here — the mobile client only sends files.
     *
     * @param {Object} params
     * @param {Buffer} params.videoBuffer - Raw video bytes
     * @param {string} params.videoFilename - Original filename
     * @param {string} params.videoMimeType - MIME type (e.g. video/mp4)
     * @param {Buffer|null} params.thumbnailBuffer - Raw thumbnail bytes (optional)
     * @param {string|null} params.thumbnailFilename - Thumbnail filename (optional)
     * @param {string|null} params.thumbnailMimeType - Thumbnail MIME (optional)
     * @param {Object} params.metadata - Video metadata (title, description, etc.)
     * @param {number} params.userId - Authenticated user ID
     * @returns {Promise<Result>}
     */
    async uploadAndCreate({ videoBuffer, videoFilename, videoMimeType, thumbnailBuffer, thumbnailFilename, thumbnailMimeType, metadata, userId }) {
        if (!videoBuffer || !videoBuffer.length) {
            return Result.fail(new ValidationError('Video file is required'));
        }
        if (!metadata || !metadata.title) {
            return Result.fail(new ValidationError('Title is required'));
        }
        if (!this.storage || !this.storage.isAvailable()) {
            return Result.fail(new Error('Storage service not available'));
        }

        try {
            // 1. Upload video to R2
            const sanitizedTitle = (metadata.title || 'video').replace(/[^a-zA-Z0-9._-]/g, '_');
            const videoExt = path.extname(videoFilename || '.mp4') || '.mp4';
            const videoKey = `videos/${Date.now()}_${sanitizedTitle}${videoExt}`;
            const videoPublicUrl = await this.storage.uploadFile(videoBuffer, videoKey, videoMimeType || 'video/mp4');

            // 2. Upload thumbnail if provided
            let thumbnailUrl = null;
            if (thumbnailBuffer && thumbnailBuffer.length > 0) {
                const thumbExt = path.extname(thumbnailFilename || '.jpg') || '.jpg';
                const thumbKey = `thumbnails/courses/thumb_${Date.now()}${thumbExt}`;
                thumbnailUrl = await this.storage.uploadFile(thumbnailBuffer, thumbKey, thumbnailMimeType || 'image/jpeg');
            }

            // 3. Create video record in the database
            const videoData = {
                title: metadata.title,
                description: metadata.description || '',
                video_uri_string: videoKey, // Store the object key, not the full URL
                thumbnail_uri: thumbnailUrl || null,
                is_paid: metadata.isPaid || false,
                price: metadata.price || null,
                course_id: metadata.courseId || null,
                user_id: userId,
                remote_id: userId,
                timestamp: metadata.timestamp || Date.now(),
            };

            const created = await this.videoRepo.create(videoData);

            // Sign URLs before returning
            await this._signUrls(created);

            return Result.ok(created);
        } catch (error) {
            console.error('[VideoDomainService] uploadAndCreate error:', error.message);
            return Result.fail(error);
        }
    }

    async create(videoData) {
        const created = await this.videoRepo.create(videoData);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const video = await this.videoRepo.findById(id);
        if (!video) return Result.fail(new NotFoundError('Video', id));
        if (video.user_id && video.user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para editar este video'));
        }
        const updated = await this.videoRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const video = await this.videoRepo.findById(id);
        if (!video) return Result.fail(new NotFoundError('Video', id));
        if (video.user_id && video.user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para eliminar este video'));
        }
        await this.videoRepo.delete(id);
        return Result.ok({ message: 'Video eliminado' });
    }

    async findByCourseIds(courseIds, pagination) {
        const videos = await this.videoRepo.findByCourseIds(courseIds, pagination);
        await this._signUrls(videos);
        return Result.ok(videos);
    }
}
export default VideoDomainService;