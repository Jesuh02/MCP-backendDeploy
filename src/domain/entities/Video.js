/**
 * Video — Entidad de dominio para Video.
 */
export class Video {
    constructor({
        id = null,
        title,
        description = '',
        videoUri = null,
        thumbnailUri = null,
        duration = null,
        username = null,
        userId = null,
        courseId = null,
        type = 'video',
        viewCount = 0,
        likeCount = 0,
        isPublished = true,
        hlsUrl = null,
        createdAt = null,
        updatedAt = null,
    } = {}) {
        Object.assign(this, {
            id,
            title,
            description,
            videoUri,
            thumbnailUri,
            duration,
            username,
            userId,
            courseId,
            type,
            viewCount,
            likeCount,
            isPublished,
            hlsUrl,
            createdAt,
            updatedAt,
        });
    }

    static fromSupabaseRow(row) {
        return new Video({
            id: row.id,
            title: row.title,
            description: row.description || '',
            videoUri: row.video_uri || row.videoUri || null,
            thumbnailUri: row.thumbnail_uri || row.thumbnailUri || null,
            duration: row.duration || null,
            username: row.username || null,
            userId: row.user_id || row.userId || null,
            courseId: row.course_id || row.courseId || null,
            type: row.type || 'video',
            viewCount: row.view_count || 0,
            likeCount: row.like_count || 0,
            isPublished: row.is_published !== false,
            hlsUrl: row.hls_url || null,
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null,
        });
    }
}

export default Video;