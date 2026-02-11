/**
 * SupabaseCourseRepository — Implementa ICourseRepository.
 */
export class SupabaseCourseRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('courses').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findAll({ offset = 0, limit = 20, sortBy = 'created_at', sortOrder = 'desc' } = {}) {
        const { data, error } = await this.client.from('courses').select('*').order(sortBy, { ascending: sortOrder === 'asc' }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByCreator(username, { offset = 0, limit = 20 } = {}) {
        // Resolve username to user ID first (courses table only has creator_user_id)
        const { data: user } = await this.client.from('usuarios').select('id').ilike('username', username).single();
        if (!user) return [];
        const { data, error } = await this.client.from('courses').select('*').eq('creator_user_id', user.id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findFree({ offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').eq('is_premium', false).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findPremium({ offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').eq('is_premium', true).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async search(query, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').or(`title.ilike.%${query}%,description.ilike.%${query}%`).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(courseData) {
        const payload = {
            title: courseData.title,
            description: courseData.description || '',
            thumbnail_uri: courseData.thumbnailUri || null,
            // creator_username column does not exist in the schema
            creator_user_id: courseData.creatorUserId || null,
            // Map isFree to is_premium
            is_premium: courseData.isFree === false,
            price: courseData.price || 0,
            category: courseData.category || null,
            // level and language columns do not exist in the schema
            is_published: courseData.isPublished !== false,
        };
        const { data, error } = await this.client.from('courses').insert(payload).select().single();
        if (error) throw new Error(`Error creando curso: ${error.message}`);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.title !== undefined) payload.title = data.title;
        if (data.description !== undefined) payload.description = data.description;
        if (data.thumbnailUri !== undefined) payload.thumbnail_uri = data.thumbnailUri;
        if (data.isFree !== undefined) payload.is_premium = data.isFree === false;
        if (data.price !== undefined) payload.price = data.price;
        if (data.category !== undefined) payload.category = data.category;
        if (data.isPublished !== undefined) payload.is_published = data.isPublished;
        payload.updated_at = new Date().toISOString();

        const { data: updated, error } = await this.client.from('courses').update(payload).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando curso: ${error.message}`);
        return updated;
    }

    async delete(id) {
        const { error } = await this.client.from('courses').delete().eq('id', id);
        if (error) throw new Error(`Error eliminando curso: ${error.message}`);
        return true;
    }

    async existsByTitle(title) {
        const { count, error } = await this.client.from('courses').select('id', { count: 'exact', head: true }).ilike('title', title);
        return !error && count > 0;
    }

    async count(filters = {}) {
        let query = this.client.from('courses').select('id', { count: 'exact', head: true });
        if (filters.creatorUserId) query = query.eq('creator_user_id', filters.creatorUserId);
        if (filters.creatorUsername) {
            // Resolve username to user ID
            const { data: user } = await this.client.from('usuarios').select('id').ilike('username', filters.creatorUsername).single();
            if (user) query = query.eq('creator_user_id', user.id);
            else return 0;
        }
        if (filters.isFree !== undefined) query = query.eq('is_premium', !filters.isFree);
        if (filters.search) query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
        const { count, error } = await query;
        return error ? 0 : count;
    }

    async findByCreatorUserId(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').eq('creator_user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const { data, error } = await this.client.from('courses').select('*').in('id', ids);
        if (error) return [];
        return data || [];
    }

    async findFreeAll({ offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').eq('is_premium', false).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseCourseRepository;