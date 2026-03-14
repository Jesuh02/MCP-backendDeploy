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

    async findByCourse(courseId, { offset = 0, limit = 50, ungradedOnly = false } = {}) {
        // Enforce strict filtering: 1. Get tasks for the course, 2. Get submissions for those tasks
        // This avoids deep nesting issues with Supabase filters
        const { data: tasks, error: taskError } = await this.client
            .from('tasks')
            .select('id, topics!inner(course_id)')
            .eq('topics.course_id', courseId);

        if (taskError) {
            console.error('Error fetching tasks for course:', taskError);
            return [];
        }

        const taskIds = tasks.map(t => t.id);
        if (taskIds.length === 0) return [];

        let query = this.client
            .from('task_submissions')
            .select('*, tasks!inner(*, topics!inner(*))')
            .in('task_id', taskIds);

        // Filter only ungraded submissions at the database level
        if (ungradedOnly) {
            query = query.is('grade', null);
        }

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('Error in findByCourse:', error);
            return [];
        }
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
        if (updateData.fileName !== undefined) payload.file_name = updateData.fileName;
        if (updateData.submissionDate !== undefined) payload.submission_date = updateData.submissionDate;

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
        const { data, error } = await this.client
            .from('task_submissions')
            .select('id, tasks!inner(topics!inner(course_id))')
            .eq('student_id', userId)
            .eq('tasks.topics.course_id', courseId);
        if (error) return 0;
        return (data || []).length;
    }

    async getGradedByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('task_submissions')
            .select('*, tasks!inner(id, title, topic_id, topics!inner(id, name, course_id))')
            .eq('student_id', userId)
            .eq('tasks.topics.course_id', courseId)
            .not('grade', 'is', null);
        if (error) return [];
        return data || [];
    }

    async getTaskIdsByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('task_submissions')
            .select('task_id, tasks!inner(topics!inner(course_id))')
            .eq('student_id', userId)
            .eq('tasks.topics.course_id', courseId);
        if (error || !data) return [];
        return [...new Set(data.map(item => item.task_id).filter(Boolean))];
    }

    async getStudentIdsByCourse(courseId) {
        const { data: tasks, error: taskError } = await this.client
            .from('tasks')
            .select('id, topics!inner(course_id)')
            .eq('topics.course_id', courseId);

        if (taskError || !tasks || tasks.length === 0) return [];

        const taskIds = tasks.map(t => t.id).filter(Boolean);
        if (taskIds.length === 0) return [];

        const { data, error } = await this.client
            .from('task_submissions')
            .select('student_id')
            .in('task_id', taskIds)
            .not('student_id', 'is', null);

        if (error || !data) return [];

        return [...new Set(data.map(item => item.student_id).filter(id => Number.isInteger(id) && id > 0))];
    }
}
export default SupabaseSubmissionRepository;