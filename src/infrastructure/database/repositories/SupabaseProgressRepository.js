export class SupabaseProgressRepository {
    constructor(client) { this.client = client; }

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('usuario_estudiante', userId).eq('curso_id', courseId).single();
        if (error || !data) return null;
        return this._mapToDomain(data);
    }

    async findByUser(userId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('usuario_estudiante', userId).order('ultima_calculada_en', { ascending: false });
        if (error) return [];
        return data ? data.map(this._mapToDomain) : [];
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('curso_id', courseId);
        if (error) return [];
        return data ? data.map(this._mapToDomain) : [];
    }

    async upsert(progressData) {
        // Guard against null/undefined required fields
        if (!progressData.courseId) throw new Error('courseId is required for progress upsert');
        if (!progressData.userId) throw new Error('userId is required for progress upsert');
        const payload = {
            usuario_estudiante: progressData.userId,
            curso_id: progressData.courseId,
            tareas_completadas: progressData.completedTasks || 0,
            tareas_totales: progressData.totalTasks || 0,
            promedio: (progressData.averageGrade !== undefined && progressData.averageGrade !== null) ? progressData.averageGrade : 0,
            porcentaje_progreso: progressData.progressPercentage || 0,
            ultima_calculada_en: new Date().toISOString(),
        };
        // State is usually generated or has a default, avoid inserting if causing issues
        // if (progressData.status) payload.estado = progressData.status;

        // Ensure calificacion_ponderada is set if averageGrade is provided, as it drives 'estado'
        if (progressData.averageGrade !== undefined && progressData.averageGrade !== null) {
            payload.calificacion_ponderada = progressData.averageGrade;
        }

        const { data, error } = await this.client.from('progreso_estudiante').upsert(payload, { onConflict: 'usuario_estudiante,curso_id' }).select().single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async delete(userId, courseId) {
        const { error } = await this.client.from('progreso_estudiante').delete().eq('usuario_estudiante', userId).eq('curso_id', courseId);
        if (error) throw new Error(error.message);
        return true;
    }

    async getLeaderboard(courseId, limit) {
        limit = limit || 10;
        const { data, error } = await this.client.from('progreso_estudiante').select('*').eq('curso_id', courseId).order('porcentaje_progreso', { ascending: false }).limit(limit);
        if (error) return [];
        return data ? data.map(this._mapToDomain) : [];
    }

    async countByCourse(courseId) {
        const { count, error } = await this.client.from('progreso_estudiante').select('usuario_estudiante', { count: 'exact', head: true }).eq('curso_id', courseId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIds(userId) {
        const { data, error } = await this.client.from('progreso_estudiante').select('curso_id').eq('usuario_estudiante', userId);
        if (error || !data) return [];
        return data.map(p => p.curso_id);
    }

    async isEnrolled(userId, courseId) {
        const { count, error } = await this.client.from('progreso_estudiante').select('usuario_estudiante', { count: 'exact', head: true }).eq('usuario_estudiante', userId).eq('curso_id', courseId);
        return !error && count > 0;
    }

    async updateCertificate(userId, courseId, data) {
        const payload = {};
        if (data.certificateIssuedAt) payload.certificado_emitido_en = data.certificateIssuedAt;
        if (data.certificateUrl) payload.certificado_url = data.certificateUrl; // Fixed column name from previous read
        const { data: updated, error } = await this.client.from('progreso_estudiante').update(payload).eq('usuario_estudiante', userId).eq('curso_id', courseId).select().single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(updated);
    }

    async getTopStudentsGlobal(limit = 10) {
        const { data, error } = await this.client.from('progreso_estudiante').select('*').order('porcentaje_progreso', { ascending: false }).limit(limit);
        if (error) return [];
        return data ? data.map(this._mapToDomain) : [];
    }

    _mapToDomain(dbRecord) {
        if (!dbRecord) return null;
        return {
            userId: dbRecord.usuario_estudiante,
            courseId: dbRecord.curso_id,
            completedTasks: dbRecord.tareas_completadas,
            totalTasks: dbRecord.tareas_totales,
            averageGrade: dbRecord.promedio,
            progressPercentage: dbRecord.porcentaje_progreso,
            status: dbRecord.estado,
            lastActivityAt: dbRecord.ultima_calculada_en,
            certificateIssuedAt: dbRecord.certificado_emitido_en,
            certificateUrl: dbRecord.certificado_url
        };
    }
}
export default SupabaseProgressRepository;