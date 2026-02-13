export class SupabaseVideoRepository {
    constructor(client) { this.client = client; }

    /**
     * Guard: Throws a descriptive error if the Supabase client is not available.
     * Follows Fail-Fast principle — callers get a clear message instead of NPE.
     */
    _requireClient() {
        if (!this.client) {
            throw new Error('Database client not available. Check SUPABASE_URL and SUPABASE_SERVICE_KEY.');
        }
    }

    _mapVideo(video) {
        if (!video) return null;
        let username = '';
        if (video.usuarios) {
            username = video.usuarios.username;
        } else if (video.username) {
            username = video.username;
        }
        const { usuarios, ...rest } = video;
        return {
            ...rest,
            username: username,
            videoUriString: video.video_uri_string || video.video_uri,
            thumbnailUri: video.thumbnail_uri,
            remoteId: video.remote_id,
            courseId: video.course_id,
            userId: video.remote_id
        };
    }

    async findById(id) {
        this._requireClient();
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .eq('id', id)
            .single();
        if (error || !data) return null;
        return this._mapVideo(data);
    }

    async findAll({ offset = 0, limit = 20, sortBy = 'created_at', sortOrder = 'desc' } = {}) {
        this._requireClient();
        const effectiveSortBy = (sortBy && sortBy !== 'null') ? sortBy : 'created_at';
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .order(effectiveSortBy, { ascending: sortOrder === 'asc' })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(v => this._mapVideo(v));
    }

    async findByCreator(username, { offset = 0, limit = 20 } = {}) {
        this._requireClient();
        // First get the user ID using the username
        const { data: userData, error: userError } = await this.client
            .from('usuarios')
            .select('id')
            .eq('username', username)
            .single();

        if (userError || !userData) {
            console.warn(`[SupabaseVideoRepository] User not found for username: ${username}`);
            return [];
        }

        // Query videos using remote_id (user ID)
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .eq('remote_id', userData.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return (data || []).map(v => this._mapVideo(v));
    }

    async findByCreatorId(userId, { offset = 0, limit = 20 } = {}) {
        this._requireClient();
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .eq('remote_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return (data || []).map(v => this._mapVideo(v));
    }

    async findByCourse(courseId, { offset = 0, limit = 20 } = {}) {
        this._requireClient();
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .eq('course_id', courseId)
            .order('created_at', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(v => this._mapVideo(v));
    }

    async search(query, { offset = 0, limit = 20 } = {}) {
        this._requireClient();
        const pattern = '%' + query + '%';
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .or('title.ilike.' + pattern + ',description.ilike.' + pattern)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(v => this._mapVideo(v));
    }

    async create(videoData) {
        this._requireClient();
        const payload = {
            title: videoData.title,
            description: videoData.description || '',
            video_uri_string: videoData.videoUri || null,
            thumbnail_uri: videoData.thumbnailUri || null,
            duration: videoData.duration || null,
            remote_id: videoData.userId || null,
            course_id: videoData.courseId || null,
            type: videoData.type || 'video',
            hls_url: videoData.hlsUrl || null,
            is_published: videoData.isPublished !== false,
        };
        const { data, error } = await this.client.from('videos').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return this._mapVideo(data);
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.title !== undefined) payload.title = updateData.title;
        if (updateData.description !== undefined) payload.description = updateData.description;
        if (updateData.videoUri !== undefined) payload.video_uri_string = updateData.videoUri;
        if (updateData.thumbnailUri !== undefined) payload.thumbnail_uri = updateData.thumbnailUri;
        if (updateData.duration !== undefined) payload.duration = updateData.duration;
        if (updateData.userId !== undefined) payload.remote_id = updateData.userId;
        if (updateData.courseId !== undefined) payload.course_id = updateData.courseId;
        if (updateData.type !== undefined) payload.type = updateData.type;
        if (updateData.hlsUrl !== undefined) payload.hls_url = updateData.hlsUrl;
        if (updateData.isPublished !== undefined) payload.is_published = updateData.isPublished;

        payload.updated_at = new Date().toISOString();
        const { data, error } = await this.client.from('videos').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return this._mapVideo(data);
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
        this._requireClient();
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
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .in('course_id', courseIds)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return (data || []).map(v => this._mapVideo(v));
    }

    /**
     * Fetch multiple videos by their IDs in a single query.
     * Used by the batch-signed-urls endpoint for mobile pre-loading.
     * @param {number[]} ids
     * @returns {Promise<Object[]>}
     */
    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        this._requireClient();
        const { data, error } = await this.client
            .from('videos')
            .select('*, usuarios!remote_id(username)')
            .in('id', ids);
        if (error) throw new Error(error.message);
        return (data || []).map(v => this._mapVideo(v));
    }
}
export default SupabaseVideoRepository;