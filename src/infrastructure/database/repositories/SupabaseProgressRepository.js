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

    async findByCourseIds(courseIds = []) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .in('curso_id', courseIds);
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

    async countEnrolled(userId) {
        const { count, error } = await this.client.from('progreso_estudiante').select('curso_id', { count: 'exact', head: true }).eq('usuario_estudiante', userId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIdsPaginated(userId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client.from('progreso_estudiante').select('curso_id').eq('usuario_estudiante', userId).order('ultima_calculada_en', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data.map(p => p.curso_id);
    }

    /**
     * Obtiene registros de progreso con estado 'Ganado' para los cursos indicados.
     * Responsabilidad única: solo consulta progreso_estudiante.
     * @param {number[]} courseIds  IDs de los cursos a consultar.
     * @returns {Promise<Array<{userId:number, courseId:number, grade:number}>>}
     */
    async findWonProgressByCourseIds(courseIds) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];

        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, curso_id, calificacion_ponderada, promedio')
            .in('curso_id', courseIds)
            .eq('estado', 'Ganado')
            .not('usuario_estudiante', 'is', null);

        if (error) {
            console.error('[ProgressRepo] findWonProgressByCourseIds error:', error.message);
            return [];
        }

        return (data || []).map(row => ({
            userId: Number(row.usuario_estudiante),
            courseId: Number(row.curso_id),
            grade: Number(row.calificacion_ponderada ?? row.promedio ?? 0),
        }));
    }

    async updateCertificate(userId, courseId, data) {
        const payload = {};
        if (data.certificateIssuedAt) payload.certificado_emitido_en = data.certificateIssuedAt;
        if (data.certificateUrl) payload.certificado_url = data.certificateUrl; // Fixed column name from previous read
        const { data: updated, error } = await this.client.from('progreso_estudiante').update(payload).eq('usuario_estudiante', userId).eq('curso_id', courseId).select().single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(updated);
    }

    /**
     * Obtiene los estudiantes destacados de los cursos de un creador.
     *
     * Flujo (3 consultas independientes — no depende de FK implícitas):
     *  1. courses  → IDs de cursos del creador  (creator_user_id)
     *  2. progreso_estudiante → registros con estado 'Ganado' en esos cursos
     *  3. usuarios → perfil (username, avatar) de los estudiantes encontrados
     *
     * @param {number} limit        Máximo de estudiantes a devolver.
     * @param {number} creatorUserId  ID del creador autenticado.
     * @returns {Promise<Array<{user_id,username,avatar,approved_courses,average_grade}>>}
     */
    async getTopStudentsGlobal(limit = 5, creatorUserId = null) {
        const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 5;
        const creatorId = Number(creatorUserId);
        if (!Number.isInteger(creatorId) || creatorId <= 0) return [];

        // ── Paso 1: Obtener IDs de cursos creados por el usuario ──
        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses')
            .select('id')
            .eq('creator_user_id', creatorId);

        if (coursesError || !creatorCourses || creatorCourses.length === 0) return [];

        const courseIds = creatorCourses.map(c => c.id);

        // ── Paso 2: Obtener progreso 'Ganado' en esos cursos ──
        const { data: progressRows, error: progressError } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, estado, calificacion_ponderada, promedio')
            .in('curso_id', courseIds)
            .eq('estado', 'Ganado')
            .not('usuario_estudiante', 'is', null);

        if (progressError || !progressRows || progressRows.length === 0) return [];

        // ── Agregar métricas por estudiante ──
        const aggregatedByUser = new Map();

        for (const row of progressRows) {
            const userId = Number(row?.usuario_estudiante);
            if (!Number.isInteger(userId) || userId <= 0) continue;

            const existing = aggregatedByUser.get(userId) || {
                user_id: userId,
                approved_courses: 0,
                total_grade: 0,
                graded_courses: 0,
                average_grade: 0,
                username: null,
                avatar: null,
            };

            existing.approved_courses += 1;

            const gradeRaw = row?.calificacion_ponderada ?? row?.promedio;
            const grade = Number(gradeRaw);
            if (Number.isFinite(grade)) {
                existing.total_grade += grade;
                existing.graded_courses += 1;
            }

            aggregatedByUser.set(userId, existing);
        }

        for (const student of aggregatedByUser.values()) {
            if (student.graded_courses > 0) {
                student.average_grade = Number((student.total_grade / student.graded_courses).toFixed(2));
            }
        }

        const ranked = [...aggregatedByUser.values()]
            .filter((student) => student.approved_courses > 0)
            .sort((a, b) => {
                if (b.average_grade !== a.average_grade) return b.average_grade - a.average_grade;
                if (b.approved_courses !== a.approved_courses) return b.approved_courses - a.approved_courses;
                return a.user_id - b.user_id;
            })
            .slice(0, safeLimit);

        // ── Paso 3: Obtener perfiles de los estudiantes encontrados ──
        const studentIds = ranked.map(s => s.user_id);

        if (studentIds.length > 0) {
            const { data: usersData } = await this.client
                .from('usuarios')
                .select('id, username, avatar')
                .in('id', studentIds);

            const usersById = new Map((usersData || []).map((user) => [Number(user.id), user]));

            for (const student of ranked) {
                const user = usersById.get(student.user_id);
                if (!user) continue;
                if (user.username) student.username = user.username;
                if (user.avatar) student.avatar = user.avatar;
            }
        }

        return ranked.map((student) => ({
            user_id: student.user_id,
            username: student.username || `Usuario ${student.user_id}`,
            avatar: student.avatar || null,
            approved_courses: student.approved_courses,
            average_grade: student.average_grade,
        }));
    }

    async getCreatorEnrollmentAnalytics(creatorUserId, { weeklyDays = 7, monthlyMonths = 6 } = {}) {
        const safeWeeklyDays = Number.isInteger(weeklyDays) && weeklyDays > 0 ? weeklyDays : 7;
        const safeMonthlyMonths = Number.isInteger(monthlyMonths) && monthlyMonths > 0 ? monthlyMonths : 6;

        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses')
            .select('id')
            .eq('creator_user_id', creatorUserId);

        if (coursesError || !creatorCourses || creatorCourses.length === 0) {
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);
        }

        const courseIds = creatorCourses.map((course) => course.id);
        const { data: progressRows, error: progressError } = await this.client
            .from('progreso_estudiante')
            .select('creado_en, ultima_calculada_en')
            .in('curso_id', courseIds);

        if (progressError || !progressRows) {
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);
        }

        return this._aggregateCreatorEnrollmentAnalytics(progressRows, safeWeeklyDays, safeMonthlyMonths);
    }

    _buildEmptyCreatorEnrollmentAnalytics(weeklyDays, monthlyMonths) {
        const dailyBuckets = this._createDailyBuckets(weeklyDays);
        const monthlyBuckets = this._createMonthlyBuckets(monthlyMonths);

        return {
            weekly: {
                labels: dailyBuckets.map((bucket) => bucket.label),
                values: dailyBuckets.map(() => 0),
            },
            monthly: {
                labels: monthlyBuckets.map((bucket) => bucket.label),
                values: monthlyBuckets.map(() => 0),
            },
            totalEnrollments: 0,
        };
    }

    _aggregateCreatorEnrollmentAnalytics(progressRows, weeklyDays, monthlyMonths) {
        const dailyBuckets = this._createDailyBuckets(weeklyDays);
        const monthlyBuckets = this._createMonthlyBuckets(monthlyMonths);

        const dailyIndexByKey = new Map(dailyBuckets.map((bucket, index) => [bucket.key, index]));
        const monthlyIndexByKey = new Map(monthlyBuckets.map((bucket, index) => [bucket.key, index]));

        for (const row of progressRows) {
            const rawDate = row.creado_en || row.ultima_calculada_en;
            if (!rawDate) continue;

            const enrollmentDate = new Date(rawDate);
            if (Number.isNaN(enrollmentDate.getTime())) continue;

            const dayKey = this._formatDayKeyUtc(enrollmentDate);
            const dayIndex = dailyIndexByKey.get(dayKey);
            if (dayIndex !== undefined) {
                dailyBuckets[dayIndex].count += 1;
            }

            const monthKey = this._formatMonthKeyUtc(enrollmentDate);
            const monthIndex = monthlyIndexByKey.get(monthKey);
            if (monthIndex !== undefined) {
                monthlyBuckets[monthIndex].count += 1;
            }
        }

        return {
            weekly: {
                labels: dailyBuckets.map((bucket) => bucket.label),
                values: dailyBuckets.map((bucket) => bucket.count),
            },
            monthly: {
                labels: monthlyBuckets.map((bucket) => bucket.label),
                values: monthlyBuckets.map((bucket) => bucket.count),
            },
            totalEnrollments: progressRows.length,
        };
    }

    _createDailyBuckets(weeklyDays) {
        const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const now = new Date();
        const buckets = [];

        for (let offset = weeklyDays - 1; offset >= 0; offset--) {
            const date = new Date(Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate() - offset,
            ));

            buckets.push({
                key: this._formatDayKeyUtc(date),
                label: dayLabels[date.getUTCDay()],
                count: 0,
            });
        }

        return buckets;
    }

    _createMonthlyBuckets(monthlyMonths) {
        const monthLabels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const now = new Date();
        const buckets = [];

        for (let offset = monthlyMonths - 1; offset >= 0; offset--) {
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
            buckets.push({
                key: this._formatMonthKeyUtc(date),
                label: monthLabels[date.getUTCMonth()],
                count: 0,
            });
        }

        return buckets;
    }

    _formatDayKeyUtc(date) {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    _formatMonthKeyUtc(date) {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        return `${year}-${month}`;
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