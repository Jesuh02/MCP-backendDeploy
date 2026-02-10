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

            // Use camelCase properties as they come from VideoComment entity
            const videoId = comment.videoId || comment.video_id;
            const userId = comment.userId || comment.usuario_id || comment.user_id;

            const video = await this.videoRepo.findById(videoId);
            if (!video) return;

            const commenter = await this.userRepo.findById(userId);
            const avatar = commenter ? commenter.avatar : '';

            // 1. Si es respuesta a otro comentario (reply)
            const parentId = comment.parentId || comment.parent_id;
            if (parentId) {
                const parentComment = await this.commentRepo.findById(parentId);
                // Check parentComment user (handle both camelCase and snake_case just in case)
                const parentUserId = parentComment ? (parentComment.userId || parentComment.usuario_id || parentComment.user_id) : null;

                if (parentComment && parentUserId && parentUserId !== userId) {
                    await this.notificationService.send(parentUserId, {
                        type: 'comment_reply',
                        title: 'Nueva respuesta',
                        message: `${comment.username || 'Alguien'} respondió a tu comentario`,
                        data: { videoId: videoId, commentId: comment.id, type: 'comment_reply' },
                        relatedId: videoId,
                        senderUsername: comment.username,
                        senderAvatarUrl: avatar,
                        thumbnailUrl: video.thumbnail_uri,
                        metadata: { replyText: comment.comment || comment.content }
                    });
                }
            }
            // 2. Si es comentario raíz, notificar al dueño del video
            else if (video.remote_id && video.remote_id !== userId) {
                // Verificar si el dueño del video no es el mismo que comenta
                await this.notificationService.send(video.remote_id, {
                    type: 'video_comment',
                    title: 'Nuevo comentario',
                    message: `${comment.username || 'Alguien'} comentó tu video`,
                    data: { videoId: videoId, commentId: comment.id, type: 'video_comment' },
                    relatedId: videoId,
                    senderUsername: comment.username,
                    senderAvatarUrl: avatar,
                    thumbnailUrl: video.thumbnail_uri,
                    metadata: { commentText: comment.comment || comment.content }
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