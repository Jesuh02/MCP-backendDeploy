export class SupabaseVideoRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('videos').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findAll({ offset = 0, limit = 20, sortBy = 'created_at', sortOrder = 'desc' } = {}) {
        const { data, error } = await this.client.from('videos').select('*').order(sortBy, { ascending: sortOrder === 'asc' }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByCreator(username, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client.from('videos').select('*').ilike('username', username).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByCourse(courseId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client.from('videos').select('*').eq('course_id', courseId).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async search(query, { offset = 0, limit = 20 } = {}) {
        const pattern = '%' + query + '%';
        const { data, error } = await this.client.from('videos').select('*').or('title.ilike.' + pattern + ',description.ilike.' + pattern).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(videoData) {
        const payload = {
            title: videoData.title,
            description: videoData.description || '',
            video_uri: videoData.videoUri || null,
            thumbnail_uri: videoData.thumbnailUri || null,
            duration: videoData.duration || null,
            username: videoData.username || null,
            user_id: videoData.userId || null,
            course_id: videoData.courseId || null,
            type: videoData.type || 'video',
            hls_url: videoData.hlsUrl || null,
            is_published: videoData.isPublished !== false,
        };
        const { data, error } = await this.client.from('videos').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, updateData) {
        const payload = {};
        var fields = ['title', 'description', 'videoUri', 'thumbnailUri', 'duration', 'username', 'userId', 'courseId', 'type', 'hlsUrl', 'isPublished'];
        var dbCols = ['title', 'description', 'video_uri', 'thumbnail_uri', 'duration', 'username', 'user_id', 'course_id', 'type', 'hls_url', 'is_published'];
        for (var i = 0; i < fields.length; i++) {
            if (updateData[fields[i]] !== undefined) payload[dbCols[i]] = updateData[fields[i]];
        }
        payload.updated_at = new Date().toISOString();
        const { data, error } = await this.client.from('videos').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async delete(id) {
        const { error } = await this.client.from('videos').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async existsByTitleAndCourse(title, courseId) {
        let q = this.client.from('videos').select('id', { count: 'exact', head: true }).ilike('title', title);
        if (courseId) q = q.eq('course_id', courseId);
        const { count, error } = await q;
        return !error && count > 0;
    }

    async count(filters) {
        filters = filters || {};
        let q = this.client.from('videos').select('id', { count: 'exact', head: true });
        if (filters.username) q = q.ilike('username', filters.username);
        if (filters.courseId) q = q.eq('course_id', filters.courseId);
        if (filters.search) {
            var p = '%' + filters.search + '%';
            q = q.or('title.ilike.' + p + ',description.ilike.' + p);
        }
        const { count, error } = await q;
        return error ? 0 : count;
    }

    async findByCourseIds(courseIds, { offset = 0, limit = 100 } = {}) {
        if (!courseIds || courseIds.length === 0) return [];
        const { data, error } = await this.client.from('videos').select('*').in('course_id', courseIds).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseVideoRepository;