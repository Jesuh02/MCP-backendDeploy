import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class VideoDomainService {
    constructor({ videoRepository }) {
        this.videoRepo = videoRepository;
    }

    async getById(id) {
        const video = await this.videoRepo.findById(id);
        if (!video) return Result.fail(new NotFoundError('Video', id));
        return Result.ok(video);
    }

    async list(pagination) {
        const [videos, total] = await Promise.all([
            this.videoRepo.findAll(pagination),
            this.videoRepo.count({}),
        ]);
        return Result.ok({ videos, total });
    }

    async findByCreator(username, pagination) {
        const videos = await this.videoRepo.findByCreator(username, pagination);
        return Result.ok(videos);
    }

    async findByCourse(courseId, pagination) {
        const videos = await this.videoRepo.findByCourse(courseId, pagination);
        return Result.ok(videos);
    }

    async search(query, pagination) {
        const videos = await this.videoRepo.search(query, pagination);
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
        return Result.ok(videos);
    }
}
export default VideoDomainService;