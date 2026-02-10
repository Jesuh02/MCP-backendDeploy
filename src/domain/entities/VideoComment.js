/**
 * VideoComment — Comentario en un video.
 */
export class VideoComment {
    constructor({ id = null, videoId, userId, username = null, content = '', parentId = null, likeCount = 0, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, videoId, userId, username, content, parentId, likeCount, createdAt, updatedAt });
    }
    static fromSupabaseRow(row) {
        return new VideoComment({
            id: row.id,
            videoId: row.video_id || row.videoId,
            userId: row.user_id || row.userId,
            username: row.username || null,
            content: row.content || '',
            parentId: row.parent_id || row.parentId || null,
            likeCount: row.like_count || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default VideoComment;