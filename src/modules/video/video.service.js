import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';
import path from 'path';
import { createReadStream } from 'fs';

export class VideoDomainService {
    constructor({ videoRepository, fileStoragePort, courseRepository, notificationService, subscriptionService, userRepository }) {
        this.videoRepo = videoRepository;
        this.storage = fileStoragePort || null;
        this.courseRepo = courseRepository || null;
        this.notificationService = notificationService || null;
        this.subscriptionService = subscriptionService || null;
        this.userRepo = userRepository || null;
    }

    /**
     * Resolves and signs all video/thumbnail URLs so clients receive
     * ready-to-play pre-signed URLs in every response.
     *
     * Handles three URL formats stored in the DB:
     *  1. Relative R2 object key  → "videos/123_file.mp4"
     *  2. Public R2 HTTP URL      → "https://pub-xxx.r2.dev/videos/..."
     *  3. Already-signed URL      → contains "X-Amz-Signature" (skip)
     *
     * Principle: OCP — new URL formats can be added without modifying
     * existing signing logic; just extend _resolveAndSign.
     */
    async _signUrls(videos) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return videos;
        const list = Array.isArray(videos) ? videos : [videos];
        await Promise.all(list.map(async(v) => {
            if (!v) return;
            try {
                // Sign video URL
                const videoUrl = v.video_uri_string || v.videoUriString;
                if (videoUrl) {
                    const signed = await this._resolveAndSign(videoUrl);
                    if (signed) {
                        v.video_uri_string = signed;
                        v.videoUriString = signed;
                    }
                }
                // Sign thumbnail URL
                const thumbUrl = v.thumbnail_uri || v.thumbnailUri;
                if (thumbUrl) {
                    const signed = await this._resolveAndSign(thumbUrl);
                    if (signed) {
                        v.thumbnail_uri = signed;
                        v.thumbnailUri = signed;
                    }
                }
            } catch (e) {
                console.warn('[VideoDomainService] Error signing URL for video', v.id, e.message);
            }
        }));
        return Array.isArray(videos) ? list : list[0];
    }

    /**
     * Resolves a raw URL/key to a pre-signed download URL.
     *
     * @param {string} raw — R2 object key, public URL, or signed URL.
     * @returns {Promise<string|null>} Pre-signed URL or null if already signed.
     * @private
     */
    async _resolveAndSign(raw) {
        if (!raw) return null;

        // Already signed — skip
        if (raw.includes('X-Amz-Signature')) return null;

        let objectKey = null;

        if (raw.startsWith('http://') || raw.startsWith('https://')) {
            // Full HTTP URL — extract R2 object key
            objectKey = this.storage.extractObjectKey(raw);

            // Fallback: extract key from backend proxy URL stored in DB.
            // e.g. https://backend.railway.app/api/v1/public/files/videos/abc.mp4
            //   → videos/abc.mp4
            if (!objectKey) {
                const m = raw.match(/\/(?:api\/v1\/)?public\/files\/(.+?)(?:\?.*)?$/);
                if (m) objectKey = decodeURIComponent(m[1]);
            }
        } else if (!raw.startsWith('file://') && !raw.startsWith('content://')) {
            // Relative R2 object key stored directly in DB (e.g. "videos/123.mp4")
            objectKey = raw;
        }

        if (!objectKey) return null;

        return this.storage.generateDownloadUrl(objectKey, 3600);
    }

    _normalizeAssetKey(raw) {
        if (!raw) return null;

        if (raw.startsWith('file://') || raw.startsWith('content://')) {
            return null;
        }

        if (raw.startsWith('http://') || raw.startsWith('https://')) {
            const extracted = this.storage?.extractObjectKey?.(raw);
            if (extracted) return extracted;

            try {
                const url = new URL(raw);
                return url.pathname.replace(/^\/+/, '') || null;
            } catch {
                return raw.split('?')[0] || null;
            }
        }

        return raw;
    }

    _clearThumbnail(video) {
        if (!video) return;
        video.thumbnail_uri = null;
        video.thumbnailUri = null;
    }

    _toBoolean(value, fallback = false) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
        }
        return fallback;
    }

    _toNullableNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    _normalizeCreateInput(input = {}) {
        const title = String(input.title || '').trim();
        const description = input.description == null ? '' : String(input.description);
        const videoUri = input.videoUri || input.videoUriString || input.video_uri_string || null;
        const thumbnailUri = input.thumbnailUri || input.thumbnail_uri || null;
        const courseId = this._toNullableNumber(input.courseId ?? input.course_id);
        const userId = this._toNullableNumber(input.userId ?? input.user_id ?? input.remote_id);
        const price = this._toNullableNumber(input.price);
        const timestamp = this._toNullableNumber(input.timestamp) || Date.now();
        const isPaid = this._toBoolean(input.isPaid ?? input.is_paid, false);

        return {
            title,
            description,
            videoUri,
            thumbnailUri,
            courseId,
            userId,
            price: isPaid ? price : null,
            isPaid,
            timestamp,
        };
    }

    async _removeCourseThumbnailFallback(videos) {
        if (!this.courseRepo) return videos;

        const list = Array.isArray(videos) ? videos : [videos];
        const candidates = list.filter((video) => {
            if (!video) return false;
            const thumb = video.thumbnail_uri || video.thumbnailUri;
            const courseId = video.course_id || video.courseId;
            return Boolean(thumb && courseId);
        });

        if (candidates.length === 0) return videos;

        const courseIds = [...new Set(candidates
            .map((video) => Number(video.course_id || video.courseId))
            .filter((courseId) => !Number.isNaN(courseId) && courseId > 0))];

        if (courseIds.length === 0) return videos;

        let courses = [];
        try {
            if (typeof this.courseRepo.findByIds === 'function') {
                courses = await this.courseRepo.findByIds(courseIds);
            } else {
                courses = (await Promise.all(courseIds.map((courseId) => this.courseRepo.findById(courseId))))
                    .filter(Boolean);
            }
        } catch (error) {
            console.warn('[VideoDomainService] Error loading course thumbnails for sanitization:', error.message);
            return videos;
        }

        const courseThumbById = new Map(courses.map((course) => [
            Number(course.id),
            this._normalizeAssetKey(course.thumbnail_url || course.thumbnail_uri || course.thumbnailUri || null),
        ]));

        for (const video of candidates) {
            const courseId = Number(video.course_id || video.courseId);
            const videoThumb = this._normalizeAssetKey(video.thumbnail_uri || video.thumbnailUri);
            const courseThumb = courseThumbById.get(courseId);

            if (videoThumb && courseThumb && videoThumb === courseThumb) {
                this._clearThumbnail(video);
            }
        }

        return videos;
    }

    async getById(id) {
        const video = await this.videoRepo.findById(id);
        if (!video) return Result.fail(new NotFoundError('Video', id));
        await this._removeCourseThumbnailFallback(video);
        await this._signUrls(video);
        return Result.ok(video);
    }

    async list(pagination) {
        const [videos, total] = await Promise.all([
            this.videoRepo.findAll(pagination),
            this.videoRepo.count({}),
        ]);
        await this._removeCourseThumbnailFallback(videos);
        await this._signUrls(videos);
        return Result.ok({ videos, total });
    }

    async findByCreator(username, pagination) {
        const videos = await this.videoRepo.findByCreator(username, pagination);
        await this._removeCourseThumbnailFallback(videos);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async findByCreatorId(userId, pagination) {
        const videos = await this.videoRepo.findByCreatorId(userId, pagination);
        await this._removeCourseThumbnailFallback(videos);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async findByCourse(courseId, pagination) {
        const videos = await this.videoRepo.findByCourse(courseId, pagination);
        await this._removeCourseThumbnailFallback(videos);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async search(query, pagination) {
        const videos = await this.videoRepo.search(query, pagination);
        await this._removeCourseThumbnailFallback(videos);
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
    async uploadAndCreate({ videoBuffer, videoPath, videoSize, videoFilename, videoMimeType, thumbnailBuffer, thumbnailPath, thumbnailSize, thumbnailFilename, thumbnailMimeType, metadata, userId }) {
        // Accept either a disk path (diskStorage) or an in-memory buffer (legacy).
        const hasVideo = videoPath || (videoBuffer && videoBuffer.length);
        if (!hasVideo) {
            return Result.fail(new ValidationError('Video file is required'));
        }
        const normalizedMetadata = this._normalizeCreateInput(metadata);
        if (!normalizedMetadata.title) {
            return Result.fail(new ValidationError('Title is required'));
        }
        if (!this.storage || !this.storage.isAvailable()) {
            return Result.fail(new Error('Storage service not available'));
        }

        try {
            // 1. Upload video to R2 — stream from disk when possible to avoid OOM.
            //    Pass ContentLength so R2 does not receive an unbounded chunked PUT.
            const sanitizedTitle = (normalizedMetadata.title || 'video').replace(/[^a-zA-Z0-9._-]/g, '_');
            const videoExt = path.extname(videoFilename || '.mp4') || '.mp4';
            const videoKey = `videos/${Date.now()}_${sanitizedTitle}${videoExt}`;
            const videoContent = videoPath ? createReadStream(videoPath) : videoBuffer;
            const videoLen = videoSize != null ? Number(videoSize) : undefined;
            await this.storage.uploadFile(videoContent, videoKey, videoMimeType || 'video/mp4', videoLen);

            // 2. Upload thumbnail if provided — also stream from disk when available.
            let thumbnailKey = null;
            const hasThumbnail = thumbnailPath || (thumbnailBuffer && thumbnailBuffer.length > 0);
            if (hasThumbnail) {
                const thumbExt = path.extname(thumbnailFilename || '.jpg') || '.jpg';
                const thumbKey = `thumbnails/videos/thumb_${Date.now()}${thumbExt}`;
                const thumbContent = thumbnailPath ? createReadStream(thumbnailPath) : thumbnailBuffer;
                const thumbLen = thumbnailSize != null ? Number(thumbnailSize) : undefined;
                await this.storage.uploadFile(thumbContent, thumbKey, thumbnailMimeType || 'image/jpeg', thumbLen);
                thumbnailKey = thumbKey;
            }

            // 3. Create video record in the database
            const videoData = {
                title: normalizedMetadata.title,
                description: normalizedMetadata.description || '',
                video_uri_string: videoKey, // Store the object key, not the full URL
                thumbnail_uri: thumbnailKey || null,
                is_paid: normalizedMetadata.isPaid,
                price: normalizedMetadata.price,
                course_id: normalizedMetadata.courseId,
                user_id: userId,
                remote_id: userId,
                timestamp: normalizedMetadata.timestamp,
            };

            const created = await this.videoRepo.create(videoData);

            // Sign URLs before returning
            await this._removeCourseThumbnailFallback(created);
            await this._signUrls(created);

            // Notify subscribers about new video (fire-and-forget)
            this._notifySubscribersAboutNewVideo(created, userId).catch(err =>
                console.warn('[VideoDomainService] Error notifying subscribers:', err.message)
            );

            return Result.ok(created);
        } catch (error) {
            console.error('[VideoDomainService] uploadAndCreate error:', error.message);
            return Result.fail(error);
        }
    }

    async _notifySubscribersAboutNewVideo(video, creatorId) {
        if (!this.notificationService || !this.subscriptionService) return;

        const subscriberResult = await this.subscriptionService.getSubscriberIds(creatorId);
        if (!subscriberResult.isOk()) return;

        const subscriberIds = subscriberResult.getValue();
        if (!subscriberIds || subscriberIds.length === 0) return;

        const creator = this.userRepo ? await this.userRepo.findById(creatorId) : null;
        const creatorUsername = creator?.username || 'Un creador';
        const creatorAvatar = creator?.avatar || null;

        const notificationData = {
            title: `📹 Nuevo video de ${creatorUsername}`,
            message: video.title || 'Nuevo video disponible',
            type: 'new_video',
            relatedId: video.id,
            senderUsername: creatorUsername,
            senderAvatarUrl: creatorAvatar,
            thumbnailUrl: video.thumbnail_uri || video.thumbnailUri || null,
            metadata: JSON.stringify({ videoId: video.id, creatorId, ...(video.course_id ? { courseId: video.course_id } : {}) }),
            actorUserId: creatorId
        };

        await this.notificationService.sendBulk(subscriberIds, notificationData);
    }

    async create(videoData) {
        const normalizedVideoData = this._normalizeCreateInput(videoData);
        if (!normalizedVideoData.title) {
            return Result.fail(new ValidationError('Title is required'));
        }
        const created = await this.videoRepo.create(normalizedVideoData);
        await this._removeCourseThumbnailFallback(created);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const video = await this.videoRepo.findById(id);
        if (!video) return Result.fail(new NotFoundError('Video', id));
        if (video.user_id && video.user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para editar este video'));
        }
        const updated = await this.videoRepo.update(id, data);
        await this._removeCourseThumbnailFallback(updated);
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

    /**
     * Batch sign URLs for multiple video IDs in a single request.
     * Optimized for mobile pre-loading: the client sends IDs of adjacent
     * videos and receives all signed URLs at once, avoiding N+1 round trips.
     *
     * @param {number[]} videoIds - Array of video IDs to sign
     * @returns {Promise<Result>} Map of { id -> { videoUrl, thumbnailUrl } }
     */
    async batchSignedUrls(videoIds) {
        if (!Array.isArray(videoIds) || videoIds.length === 0) {
            return Result.fail(new ValidationError('videoIds must be a non-empty array'));
        }
        // Cap at 20 to prevent abuse
        const ids = videoIds.slice(0, 20).map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) {
            return Result.fail(new ValidationError('No valid video IDs provided'));
        }

        try {
            const videos = await this.videoRepo.findByIds(ids);
            if (!videos || videos.length === 0) {
                return Result.ok({});
            }

            // Sign all URLs in parallel for maximum speed
            await this._removeCourseThumbnailFallback(videos);
            await this._signUrls(videos);

            // Build a lookup map keyed by video ID
            const urlMap = {};
            for (const v of videos) {
                urlMap[v.id] = {
                    videoUrl: v.video_uri_string || v.videoUriString || null,
                    thumbnailUrl: v.thumbnail_uri || v.thumbnailUri || null,
                };
            }
            return Result.ok(urlMap);
        } catch (error) {
            console.error('[VideoDomainService] batchSignedUrls error:', error.message);
            return Result.fail(error);
        }
    }

    async findByCourseIds(courseIds, pagination) {
        const videos = await this.videoRepo.findByCourseIds(courseIds, pagination);
        await this._removeCourseThumbnailFallback(videos);
        await this._signUrls(videos);
        return Result.ok(videos);
    }

    async getChanges(sinceMs) {
        const sinceIso = new Date(Number(sinceMs)).toISOString();
        const videos = await this.videoRepo.findModifiedSince(sinceIso);
        await this._removeCourseThumbnailFallback(videos);
        await this._signUrls(videos);
        const serverNow = Date.now();
        return Result.ok({ videos, serverTimestamp: serverNow });
    }
}
export default VideoDomainService;