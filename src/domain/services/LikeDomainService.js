import { Result } from '../../shared/Result.js';

export class LikeDomainService {
    constructor({ likeRepository, notificationService, commentRepository, videoRepository, userRepository }) {
        this.likeRepo = likeRepository;
        this.notificationService = notificationService;
        this.commentRepo = commentRepository;
        this.videoRepo = videoRepository;
        this.userRepo = userRepository;
    }

    async toggle(userId, entityType, entityId) {
        const existing = await this.likeRepo.findByUserAndEntity(userId, entityType, entityId);
        if (existing) {
            await this.likeRepo.delete(userId, entityType, entityId);
            const count = await this.likeRepo.countByEntity(entityType, entityId);
            return Result.ok({ liked: false, count });
        }
        await this.likeRepo.create({ userId, entityType, entityId });

        // Notification Logic
        this._handleLikeNotification(userId, entityType, entityId).catch(err => console.error('Like notif error:', err));

        const count = await this.likeRepo.countByEntity(entityType, entityId);
        return Result.ok({ liked: true, count });
    }

    async _handleLikeNotification(userId, entityType, entityId) {
        try {
            if (!this.notificationService) return;

            const liker = await this.userRepo.findById(userId);
            const senderUsername = liker ? liker.usuario : 'Alguien';
            const senderAvatar = liker ? liker.avatar : '';

            if (entityType === 'video') {
                if (!this.videoRepo) return;
                const video = await this.videoRepo.findById(entityId);
                // No notificar si se da like a sí mismo prop video
                if (video && video.remote_id && video.remote_id !== userId) {
                    await this.notificationService.send(video.remote_id, {
                        type: 'video_like',
                        title: 'Nuevo like',
                        message: `${senderUsername} le gustó tu video`,
                        data: { videoId: entityId, type: 'video_like' },
                        relatedId: entityId,
                        senderUsername: senderUsername,
                        senderAvatarUrl: senderAvatar,
                        thumbnailUrl: video.thumbnail_uri
                    });
                }
            } else if (entityType === 'comment' || entityType === 'video_comment') {
                if (!this.commentRepo || !this.videoRepo) return;
                const comment = await this.commentRepo.findById(entityId);
                if (comment && comment.usuario_id !== userId) {
                    const video = await this.videoRepo.findById(comment.video_id);
                    await this.notificationService.send(comment.usuario_id, {
                        type: 'comment_like',
                        title: 'Like en tu comentario',
                        message: `${senderUsername} le gustó tu comentario`,
                        data: { videoId: comment.video_id, commentId: entityId, type: 'comment_like' },
                        relatedId: comment.video_id, // Link to video
                        senderUsername: senderUsername,
                        senderAvatarUrl: senderAvatar,
                        thumbnailUrl: video ? video.thumbnail_uri : ''
                    });
                }
            }
        } catch (error) {
            console.error('Error sending like notification:', error);
        }
    }

    async getLikeStatus(userId, entityType, entityIds) {
        const liked = await this.likeRepo.findByUserAndEntities(userId, entityType, entityIds);
        return Result.ok(liked);
    }

    async getCount(entityType, entityId) {
        const count = await this.likeRepo.countByEntity(entityType, entityId);
        return Result.ok({ count });
    }
}
export default LikeDomainService;