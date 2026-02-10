import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class CommentDomainService {
    constructor({ commentRepository }) {
        this.commentRepo = commentRepository;
    }

    async getByVideo(videoId, pagination) {
        const comments = await this.commentRepo.findByVideo(videoId, pagination);
        return Result.ok(comments);
    }

    async create(data) {
        const created = await this.commentRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const comment = await this.commentRepo.findById(id);
        if (!comment) return Result.fail(new NotFoundError('Comentario', id));
        if (comment.user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No puedes editar este comentario'));
        }
        const updated = await this.commentRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const comment = await this.commentRepo.findById(id);
        if (!comment) return Result.fail(new NotFoundError('Comentario', id));
        if (comment.user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No puedes eliminar este comentario'));
        }
        await this.commentRepo.delete(id);
        return Result.ok({ message: 'Comentario eliminado' });
    }

    async getCount(videoId) {
        const count = await this.commentRepo.countByVideo(videoId);
        return Result.ok({ count });
    }
}
export default CommentDomainService;