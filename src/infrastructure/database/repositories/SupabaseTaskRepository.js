export class SupabaseTaskRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('tasks').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByTopic(topicId) {
        const { data, error } = await this.client.from('tasks').select('*').eq('topic_id', topicId).order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('tasks').select('*').eq('course_id', courseId).order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(taskData) {
        const payload = {
            title: taskData.title,
            description: taskData.description || '',
            topic_id: taskData.topicId,
            course_id: taskData.courseId || null,
            due_date: taskData.dueDate || null,
            max_score: taskData.maxScore || 100,
            is_active: taskData.isActive !== false,
        };
        const { data, error } = await this.client.from('tasks').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.title !== undefined) payload.title = data.title;
        if (data.description !== undefined) payload.description = data.description;
        if (data.dueDate !== undefined) payload.due_date = data.dueDate;
        if (data.maxScore !== undefined) payload.max_score = data.maxScore;
        if (data.isActive !== undefined) payload.is_active = data.isActive;
        payload.updated_at = new Date().toISOString();
        const { data: updated, error } = await this.client.from('tasks').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return updated;
    }

    async delete(id) {
        const { error } = await this.client.from('tasks').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async countByCourse(courseId) {
        const { count, error } = await this.client.from('tasks').select('id', { count: 'exact', head: true }).eq('course_id', courseId);
        return error ? 0 : count;
    }
}
export default SupabaseTaskRepository;
