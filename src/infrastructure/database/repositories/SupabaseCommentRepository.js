export class SupabaseCommentRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('video_comments').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByVideo(videoId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('video_comments').select('*').eq('video_id', videoId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(commentData) {
        const payload = {
            video_id: commentData.videoId,
            user_id: commentData.userId,
            username: commentData.username || null,
            content: commentData.content,
            parent_id: commentData.parentId || null,
        };
        const { data, error } = await this.client.from('video_comments').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.content !== undefined) payload.content = updateData.content;
        payload.updated_at = new Date().toISOString();
        const { data, error } = await this.client.from('video_comments').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return data;
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
