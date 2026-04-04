export class SupabaseCommentRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('video_comments').select('*, usuarios!usuario_id(username)').eq('id', id).single();
        if (error || !data) return null;
        return this._mapToDomain(data);
    }

    async findByVideo(videoId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('video_comments').select('*, usuarios!usuario_id(username)').eq('video_id', videoId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
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
        
        const { data, error } = await this.client.from('video_comments').insert(payload).select('*, usuarios!usuario_id(username)').single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.content !== undefined) payload.comment = updateData.content; // Map content -> comment
        payload.updated_at = new Date().toISOString();
        const { data, error } = await this.client.from('video_comments').update(payload).eq('id', id).select('*, usuarios!usuario_id(username)').single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    // Helper to map DB row to Domain Entity shape (VideoComment)
    // Returns both camelCase (internal use) and snake_case (Android client compatibility)
    _mapToDomain(row) {
        if (!row) return null;
        return {
            id: row.id,
            // camelCase (for backend domain services)
            videoId: row.video_id,
            userId: row.usuario_id,
            content: row.comment,
            parentId: row.parent_id,
            likeCount: row.like_count || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            username: row.usuarios?.username || row.username || null,
            // snake_case aliases (for Android client @SerializedName compatibility)
            video_id: row.video_id,
            usuario_id: row.usuario_id,
            comment: row.comment,
            parent_id: row.parent_id,
            created_at: row.created_at,
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


