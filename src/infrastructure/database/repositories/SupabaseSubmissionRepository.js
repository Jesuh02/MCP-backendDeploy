export class SupabaseSubmissionRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByTask(taskId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('task_id', taskId).order('submitted_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByUser(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('user_id', userId).order('submitted_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByUserAndTask(userId, taskId) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('user_id', userId).eq('task_id', taskId).order('submitted_at', { ascending: false }).limit(1).single();
        if (error || !data) return null;
        return data;
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('task_submissions').select('*, tasks!inner(course_id)').eq('tasks.course_id', courseId).order('submitted_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async create(subData) {
        const payload = {
            task_id: subData.taskId,
            user_id: subData.userId,
            username: subData.username || null,
            file_uri: subData.fileUri || null,
            file_name: subData.fileName || null,
            text_content: subData.textContent || null,
            status: 'pending',
            submitted_at: new Date().toISOString(),
        };
        const { data, error } = await this.client.from('task_submissions').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.grade !== undefined) payload.grade = updateData.grade;
        if (updateData.feedback !== undefined) payload.feedback = updateData.feedback;
        if (updateData.status !== undefined) payload.status = updateData.status;
        if (updateData.fileUri !== undefined) payload.file_uri = updateData.fileUri;
        if (updateData.textContent !== undefined) payload.text_content = updateData.textContent;
        if (updateData.status === 'graded') payload.graded_at = new Date().toISOString();
        payload.updated_at = new Date().toISOString();
        const { data, error } = await this.client.from('task_submissions').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async delete(id) {
        const { error } = await this.client.from('task_submissions').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async countByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('task_submissions').select('id, tasks!inner(course_id)').eq('user_id', userId).eq('tasks.course_id', courseId);
        if (error) return 0;
        return (data || []).length;
    }

    async getGradedByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('task_submissions').select('*, tasks!inner(course_id)').eq('user_id', userId).eq('tasks.course_id', courseId).eq('status', 'graded');
        if (error) return [];
        return data || [];
    }
}
export default SupabaseSubmissionRepository;
