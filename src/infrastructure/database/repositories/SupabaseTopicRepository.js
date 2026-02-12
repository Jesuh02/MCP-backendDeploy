export class SupabaseTopicRepository {
    constructor(client) { this.client = client; }

    async findAll(pg = {}) {
        const { offset = 0, limit = 20, sortOrder = 'asc' } = pg;
        const { data, error, count } = await this.client.from('topics').select('*', { count: 'exact' })
            .order('order_index', { ascending: sortOrder !== 'desc' })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return { topics: data || [], total: count || 0 };
    }

    async findById(id) {
        const { data, error } = await this.client.from('topics').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('topics').select('*').eq('course_id', courseId).order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(topicData) {
        const payload = {
            name: topicData.title,
            description: topicData.description || '',
            course_id: topicData.courseId,
            order_index: topicData.orderIndex || 0,
        };
        const { data, error } = await this.client.from('topics').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.title !== undefined) payload.name = data.title;
        if (data.description !== undefined) payload.description = data.description;
        if (data.orderIndex !== undefined) payload.order_index = data.orderIndex;
        payload.updated_at = new Date().toISOString();
        const { data: updated, error } = await this.client.from('topics').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return updated;
    }

    async delete(id) {
        const { error } = await this.client.from('topics').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseTopicRepository;