import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

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
        await Promise.all(list.map(async (v) => {
            if (!v) return;
            try {
                // Sign video URL (skip if already signed — contains X-Amz-Signature)
                if (v.video_uri_string || v.videoUriString) {
                    const url = v.video_uri_string || v.videoUriString;
                    if (url && !url.includes('X-Amz-Signature')) {
                        const key = this.storage.extractObjectKey(url);
                        if (key) {
                            const signed = await this.storage.generateDownloadUrl(key, 3600);
                            v.video_uri_string = signed;
                            v.videoUriString = signed;
                        }
                    }
                }
                // Sign thumbnail URL (skip if already signed)
                if (v.thumbnail_uri || v.thumbnailUri) {
                    const url = v.thumbnail_uri || v.thumbnailUri;
                    if (url && !url.includes('X-Amz-Signature')) {
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