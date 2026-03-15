export class SupabaseSubmissionRepository {
    constructor(client) { this.client = client; }

    async _getTopicIdsBySubjects(subjectIds) {
        const orFilter = subjectIds.map(id => `materia_id.eq.${id},subject_id.eq.${id}`).join(',');
        const { data, error } = await this.client
            .from('topics').select('id').or(orFilter);
        if (error || !data?.length) return [];
        return [...new Set(data.map(t => t.id))];
    }

    async _getTaskIdsByCourse(courseId) {
        const { data: subjects, error: subErr } = await this.client
            .from('subjects').select('id').eq('course_id', courseId);
        if (subErr || !subjects?.length) return [];
        const topicIds = await this._getTopicIdsBySubjects(subjects.map(s => s.id));
        if (topicIds.length === 0) return [];
        const { data: tasks, error: taskErr } = await this.client
            .from('tasks').select('id').in('topic_id', topicIds);
        if (taskErr || !tasks?.length) return [];
        return tasks.map(t => t.id);
    }

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
        const taskIds = await this._getTaskIdsByCourse(courseId);
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
        if (updateData.gradedBy !== undefined) payload.graded_by = updateData.gradedBy;
        if (updateData.gradedAt !== undefined) payload.graded_at = updateData.gradedAt;

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
        const taskIds = await this._getTaskIdsByCourse(courseId);
        if (taskIds.length === 0) return 0;
        const { data, error } = await this.client
            .from('task_submissions')
            .select('id')
            .eq('student_id', userId)
            .in('task_id', taskIds);
        if (error) return 0;
        return (data || []).length;
    }

    async getGradedByUserAndCourse(userId, courseId) {
        const taskIds = await this._getTaskIdsByCourse(courseId);
        if (taskIds.length === 0) return [];
        const { data, error } = await this.client
            .from('task_submissions')
            .select('*, tasks!inner(id, title, topic_id, topics!inner(id, name, materia_id))')
            .eq('student_id', userId)
            .in('task_id', taskIds)
            .not('grade', 'is', null);
        if (error) return [];
        return data || [];
    }

    async getTaskIdsByUserAndCourse(userId, courseId) {
        const taskIds = await this._getTaskIdsByCourse(courseId);
        if (taskIds.length === 0) return [];
        const { data, error } = await this.client
            .from('task_submissions')
            .select('task_id')
            .eq('student_id', userId)
            .in('task_id', taskIds);
        if (error || !data) return [];
        return [...new Set(data.map(item => item.task_id).filter(Boolean))];
    }

    async getStudentIdsByCourse(courseId) {
        const taskIds = await this._getTaskIdsByCourse(courseId);
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