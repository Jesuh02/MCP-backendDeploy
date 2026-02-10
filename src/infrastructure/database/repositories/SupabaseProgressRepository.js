export class SupabaseProgressRepository {
    constructor(client) { this.client = client; }

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('user_id', userId).eq('course_id', courseId).single();
        if (error || !data) return null;
        return data;
    }

    async findByUser(userId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('user_id', userId).order('last_activity_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('course_id', courseId);
        if (error) return [];
        return data || [];
    }

    async upsert(progressData) {
        const payload = {
            user_id: progressData.userId,
            course_id: progressData.courseId,
            completed_tasks: progressData.completedTasks || 0,
            total_tasks: progressData.totalTasks || 0,
            average_grade: progressData.averageGrade || 0,
            progress_percentage: progressData.progressPercentage || 0,
            last_activity_at: new Date().toISOString(),
        };
        const { data, error } = await this.client.from('progreso_estudiante').upsert(payload, { onConflict: 'user_id,course_id' }).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async delete(userId, courseId) {
        const { error } = await this.client.from('progreso_estudiante').delete().eq('user_id', userId).eq('course_id', courseId);
        if (error) throw new Error(error.message);
        return true;
    }

    async getLeaderboard(courseId, limit) {
        limit = limit || 10;
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('course_id', courseId).order('progress_percentage', { ascending: false }).limit(limit);
        if (error) return [];
        return data || [];
    }

    async countByCourse(courseId) {
        const { count, error } = await this.client.from('progreso_estudiante').select('id', { count: 'exact', head: true }).eq('course_id', courseId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIds(userId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('course_id').eq('user_id', userId);
        if (error || !data) return [];
        return data.map(p => p.course_id);
    }

    async isEnrolled(userId, courseId) {
        const { count, error } = await this.client.from('progreso_estudiante').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('course_id', courseId);
        return !error && count > 0;
    }

    async updateCertificate(userId, courseId, data) {
        const payload = {};
        if (data.certificateIssuedAt) payload.certificado_emitido_en = data.certificateIssuedAt;
        if (data.certificateUrl) payload.certificate_url = data.certificateUrl;
        const { data: updated, error } = await this.client.from('progreso_estudiante').update(payload).eq('user_id', userId).eq('course_id', courseId).select().single();
        if (error) throw new Error(error.message);
        return updated;
    }

    async getTopStudentsGlobal(limit = 10) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').order('progress_percentage', { ascending: false }).limit(limit);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseProgressRepository;