import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class VideoDomainService {
    constructor({ videoRepository, fileStoragePort }) {
        this.videoRepo = videoRepository;
        this.storage = fileStoragePort || null;
    }

    /**
     * Replace R2 URLs / object keys with signed download URLs so clients
     * can access videos without the bucket being public.
     *
     * Split-bucket strategy:
     *   - Videos  → bucket privado (coursev-files) → URL firmada con cache de 50 min
     *   - Thumbnails → bucket público (coursev-fil) → URL pública directa, sin firmar
     *
     * El campo video_uri_string puede ser:
     *   1. Un object key sin esquema: "videos/mi_video"
     *   2. Una URL pública R2: "https://pub-xxx.r2.dev/videos/mi_video"
     *   3. Una URL ya firmada (contiene X-Amz-Signature)
     */
    async _signUrls(videos) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return videos;
        const list = Array.isArray(videos) ? videos : [videos];
        await Promise.all(list.map(async(v) => {
            if (!v) return;
            try {
                // ── Video URL: siempre firmar (bucket privado) ──
                const videoUrl = v.video_uri_string || v.videoUriString;
                if (videoUrl && !videoUrl.includes('X-Amz-Signature')) {
                    let key = null;

                    if (videoUrl.startsWith('http')) {
                        // Es una URL completa → extraer object key
                        key = this.storage.extractObjectKey(videoUrl);
                    } else if (!videoUrl.startsWith('file://') && !videoUrl.startsWith('content://')) {
                        // Es un object key directo (e.g. "videos/mi_video")
                        key = videoUrl;
                    }

                    if (key) {
                        const signed = await this.storage.generateDownloadUrl(key, 3600);
                        v.video_uri_string = signed;
                        v.videoUriString = signed;
                    }
                }

                // ── Thumbnail URL: bucket público, NO firmar ──
                const thumbUrl = v.thumbnail_uri || v.thumbnailUri;
                if (thumbUrl) {
                    // Si ya es URL del bucket público de thumbnails, dejar como está
                    if (this.storage.isThumbnailPublicUrl && this.storage.isThumbnailPublicUrl(thumbUrl)) {
                        // Ya es pública, no hacer nada
                    } else if (thumbUrl.startsWith('http') && !thumbUrl.includes('X-Amz-Signature')) {
                        // Es una URL del bucket de videos (privado) → extraer key y construir URL pública de thumbnail
                        const key = this.storage.extractObjectKey(thumbUrl);
                        if (key && key.startsWith('thumbnails')) {
                            // Pertenece a thumbnails → devolver URL pública
                            const publicThumbUrl = this.storage.getThumbnailPublicUrl
                                ? this.storage.getThumbnailPublicUrl(key)
                                : thumbUrl; // fallback: dejar original
                            v.thumbnail_uri = publicThumbUrl;
                            v.thumbnailUri = publicThumbUrl;
                        } else if (key) {
                            // Thumbnail almacenado en bucket de videos → firmar como video
                            const signed = await this.storage.generateDownloadUrl(key, 3600);
                            v.thumbnail_uri = signed;
                            v.thumbnailUri = signed;
                        }
                    } else if (!thumbUrl.startsWith('http') && !thumbUrl.startsWith('file://') && !thumbUrl.startsWith('content://')) {
                        // Es un object key directo para thumbnail
                        if (this.storage.getThumbnailPublicUrl) {
                            const publicThumbUrl = this.storage.getThumbnailPublicUrl(thumbUrl);
                            v.thumbnail_uri = publicThumbUrl;
                            v.thumbnailUri = publicThumbUrl;
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
     * Genera una URL firmada a partir de un objectKey directo.
     * Usado por el frontend cuando ya conoce el key del video.
     * Aprovecha el cache interno de R2StorageAdapter (50 min TTL).
     *
     * @param {string} objectKey  e.g. "videos/mi_video"
     * @param {number} [expiresIn=3600] Tiempo de expiración en segundos
     * @returns {Result} { signedUrl, objectKey, expiresIn, cached }
     */
    async getSignedUrlByKey(objectKey, expiresIn = 3600) {
        try {
            if (!this.storage) return Result.fail(new Error("Storage service not available"));
            if (!objectKey) return Result.fail(new Error("objectKey is required"));

            const signedUrl = await this.storage.generateDownloadUrl(objectKey, expiresIn);
            return Result.ok({
                signedUrl,
                objectKey,
                expiresIn,
            });
        } catch (error) {
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