export class SupabaseSubjectRepository {
    constructor(client) { this.client = client; }

    async findAll(pg = {}) {
        const { offset = 0, limit = 20, sortOrder = 'asc' } = pg;
        const { data, error, count } = await this.client.from('subjects').select('*', { count: 'exact' })
            .eq('is_active', true)
            .order('order_index', { ascending: sortOrder !== 'desc' })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return { subjects: data || [], total: count || 0 };
    }

    async findById(id) {
        const { data, error } = await this.client.from('subjects').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('subjects').select('*')
            .eq('course_id', courseId)
            .eq('is_active', true)
            .order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(subjectData) {
        const payload = {
            course_id: subjectData.courseId,
            name: subjectData.name,
            description: subjectData.description || '',
            code: subjectData.code || null,
            thumbnail_url: subjectData.thumbnailUrl || null,
            order_index: subjectData.orderIndex ?? 0,
            is_active: subjectData.isActive ?? true,
            created_by: subjectData.createdBy || null,
        };
        const { data, error } = await this.client.from('subjects').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.name !== undefined) payload.name = data.name;
        if (data.description !== undefined) payload.description = data.description;
        if (data.code !== undefined) payload.code = data.code;
        if (data.thumbnailUrl !== undefined) payload.thumbnail_url = data.thumbnailUrl;
        if (data.orderIndex !== undefined) payload.order_index = data.orderIndex;
        if (data.isActive !== undefined) payload.is_active = data.isActive;
        if (data.updatedBy !== undefined) payload.updated_by = data.updatedBy;
        payload.updated_at = new Date().toISOString();
        const { data: updated, error } = await this.client.from('subjects').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return updated;
    }

    async delete(id) {
        const { error } = await this.client.from('subjects').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseSubjectRepository;
