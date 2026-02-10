export class SupabaseCommentRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('video_comments').select('*').eq('id', id).single();
        if (error || !data) return null;
        return this._mapToDomain(data);
    }

    async findByVideo(videoId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('video_comments').select('*').eq('video_id', videoId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(row => this._mapToDomain(row));
    }

    async create(commentData) {
        // Map domain fields to DB columns
        const payload = {
            video_id: commentData.videoId,
            usuario_id: commentData.userId, // Valid column from DDL
            comment: commentData.content,   // Valid column from DDL
            parent_id: commentData.parentId || null,
        };
        // NOTE: 'username' column does not exist in video_comments table, so we don't insert it.
        
        const { data, error } = await this.client.from('video_comments').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.content !== undefined) payload.comment = updateData.content; // Map content -> comment
        payload.updated_at = new Date().toISOString();
        const { data, error } = await this.client.from('video_comments').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    // Helper to map DB row to Domain Entity shape (VideoComment)
    _mapToDomain(row) {
        if (!row) return null;
        return {
            id: row.id,
            videoId: row.video_id,
            userId: row.usuario_id, // Map usuario_id -> userId
            username: row.username || null, // Might be missing if no join
            content: row.comment,   // Map comment -> content
            parentId: row.parent_id,
            likeCount: row.like_count || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async delete(id) {
        const { error } = await this.client.from('video_comments').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async countByVideo(videoId) {
        const { count, error } = await this.client.from('video_comments').select('id', { count: 'exact', head: true }).eq('video_id', videoId);
        return error ? 0 : count;
    }
}
export default SupabaseCommentRepository;
