import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class CommentDomainService {
    constructor({ commentRepository, videoRepository, notificationService, userRepository }) {
        this.commentRepo = commentRepository;
        this.videoRepo = videoRepository;
        this.notificationService = notificationService;
        this.userRepo = userRepository;
    }

    async getByVideo(videoId, pagination) {
        const comments = await this.commentRepo.findByVideo(videoId, pagination);
        return Result.ok(comments);
    }

    async create(data) {
        const created = await this.commentRepo.create(data);

        // Notificaciones asíncronas
        this._handleNotifications(created, data).catch(err => console.error('Notification error:', err));

        return Result.ok(created);
    }

    async _handleNotifications(comment, inputData) {
        try {
            if (!this.notificationService || !this.videoRepo || !this.userRepo) return;

            const video = await this.videoRepo.findById(comment.video_id);
            if (!video) return;

            const commenter = await this.userRepo.findById(comment.usuario_id);
            const avatar = commenter ? commenter.avatar : '';

            // 1. Si es respuesta a otro comentario (reply)
            if (comment.parent_id) {
                const parentComment = await this.commentRepo.findById(comment.parent_id);
                if (parentComment && parentComment.usuario_id !== comment.usuario_id) {
                    await this.notificationService.send(parentComment.usuario_id, {
                        type: 'comment_reply',
                        title: 'Nueva respuesta',
                        message: `${comment.username || 'Alguien'} respondió a tu comentario`,
                        data: { videoId: comment.video_id, commentId: comment.id, type: 'comment_reply' },
                        relatedId: comment.video_id,
                        senderUsername: comment.username,
                        senderAvatarUrl: avatar,
                        thumbnailUrl: video.thumbnail_uri,
                        metadata: { replyText: comment.comment }
                    });
                }
            }
            // 2. Si es comentario raíz, notificar al dueño del video
            else if (video.remote_id && video.remote_id !== comment.usuario_id) {
                // Verificar si el dueño del video no es el mismo que comenta
                await this.notificationService.send(video.remote_id, {
                    type: 'video_comment',
                    title: 'Nuevo comentario',
                    message: `${comment.username || 'Alguien'} comentó tu video`,
                    data: { videoId: comment.video_id, commentId: comment.id, type: 'video_comment' },
                    relatedId: comment.video_id,
                    senderUsername: comment.username,
                    senderAvatarUrl: avatar,
                    thumbnailUrl: video.thumbnail_uri,
                    metadata: { commentText: comment.comment }
                });
            }
        } catch (error) {
            console.error('Error sending comment notification:', error);
        }
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