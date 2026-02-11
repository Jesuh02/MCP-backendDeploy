export class SupabaseSubmissionRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByTask(taskId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('task_id', taskId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByUser(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('student_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByUserAndTask(userId, taskId) {
        const { data, error } = await this.client.from('task_submissions').select('*').eq('student_id', userId).eq('task_id', taskId).order('created_at', { ascending: false }).limit(1).single();
        if (error || !data) return null;
        return data;
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('task_submissions').select('*, tasks!inner(course_id)').eq('tasks.course_id', courseId).order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async create(subData) {
        const payload = {
            task_id: subData.taskId,
            student_id: subData.userId,
            file_uri: subData.fileUri || null,
            file_name: subData.fileName || null,
            submission_date: Date.now(),
        };
        const { data, error } = await this.client.from('task_submissions').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.grade !== undefined) payload.grade = updateData.grade;
        if (updateData.feedback !== undefined) payload.feedback = updateData.feedback;
        if (updateData.fileUri !== undefined) payload.file_uri = updateData.fileUri;

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
        const { data, error } = await this.client.from('task_submissions').select('id, tasks!inner(course_id)').eq('student_id', userId).eq('tasks.course_id', courseId);
        if (error) return 0;
        return (data || []).length;
    }

    async getGradedByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('task_submissions').select('*, tasks!inner(course_id)').eq('student_id', userId).eq('tasks.course_id', courseId).not('grade', 'is', null);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseSubmissionRepository;