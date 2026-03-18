export class SupabaseProgressRepository {
    constructor(client) { this.client = client; }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS PRIVADOS
    // ═══════════════════════════════════════════════════════════════

    /** Busca el certificado de un (user, course). Retorna null si no existe. */
    async _findCertificate(userId, courseId) {
        const { data } = await this.client
            .from('certificates')
            .select('issued_at, storage_path, verification_code')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .maybeSingle();
        return data || null;
    }

    /**
     * Carga certificados de múltiples (user, course) en una sola query.
     * Retorna Map con clave `${userId}-${courseId}`.
     */
    async _fetchCertificatesMap(courseIds, userIds = null) {
        if (!courseIds?.length) return new Map();
        let query = this.client
            .from('certificates')
            .select('user_id, course_id, issued_at, storage_path, verification_code')
            .in('course_id', courseIds);
        if (userIds?.length) query = query.in('user_id', userIds);
        const { data } = await query;
        const map = new Map();
        for (const c of data || []) {
            map.set(`${c.user_id}-${c.course_id}`, c);
        }
        return map;
    }

    /**
     * Mapea una fila de `progreso_estudiante` al objeto de dominio.
     * cert es una fila de `certificates` (opcional, solo para nivel-curso).
     */
    _mapToDomain(row, cert = null) {
        if (!row) return null;
        return {
            userId: row.usuario_estudiante,
            courseId: row.curso_id,
            subjectId: row.materia_id ?? null,   // null = nivel-curso
            completedTasks: row.tareas_completadas,
            totalTasks: row.tareas_totales,
            averageGrade: row.promedio ?? row.calificacion_ponderada ?? null,
            progressPercentage: row.porcentaje_progreso,
            status: row.estado,
            enrollment_status: 'activo',
            lastActivityAt: row.ultima_calculada_en,
            certificateIssuedAt: cert?.issued_at || null,
            certificateUrl: cert?.storage_path || null,
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESO DEL CURSO  (materia_id IS NULL)
    // ═══════════════════════════════════════════════════════════════

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .is('materia_id', null)
            .single();
        if (error || !data) return null;
        const cert = await this._findCertificate(userId, courseId);
        return this._mapToDomain(data, cert);
    }

    async findByUser(userId) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('usuario_estudiante', userId)
            .is('materia_id', null)
            .order('ultima_calculada_en', { ascending: false });
        if (error || !data?.length) return [];
        const courseIds = data.map(r => r.curso_id);
        const certsMap = await this._fetchCertificatesMap(courseIds, [userId]);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${userId}-${r.curso_id}`)));
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('curso_id', courseId)
            .is('materia_id', null);
        if (error || !data?.length) return [];
        const userIds = data.map(r => r.usuario_estudiante);
        const certsMap = await this._fetchCertificatesMap([courseId], userIds);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${r.usuario_estudiante}-${courseId}`)));
    }

    async findByCourseIds(courseIds = []) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .in('curso_id', courseIds)
            .is('materia_id', null);
        if (error || !data?.length) return [];
        const certsMap = await this._fetchCertificatesMap(courseIds);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${r.usuario_estudiante}-${r.curso_id}`)));
    }

    async findCourseEnrollmentRanking() {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('curso_id, usuario_estudiante')
            .is('materia_id', null)
            .not('curso_id', 'is', null)
            .not('usuario_estudiante', 'is', null);
        if (error || !data) return [];

        const usersByCourse = new Map();
        for (const row of data) {
            const courseId = Number(row.curso_id);
            const userId = Number(row.usuario_estudiante);
            if (!Number.isInteger(courseId) || courseId <= 0) continue;
            if (!Number.isInteger(userId) || userId <= 0) continue;
            if (!usersByCourse.has(courseId)) usersByCourse.set(courseId, new Set());
            usersByCourse.get(courseId).add(userId);
        }
        return [...usersByCourse.entries()]
            .map(([courseId, users]) => ({ courseId, enrollmentCount: users.size }))
            .sort((a, b) => b.enrollmentCount - a.enrollmentCount || a.courseId - b.courseId);
    }

    // ═══════════════════════════════════════════════════════════════
    //  UPSERT  (enruta según subjectId)
    // ═══════════════════════════════════════════════════════════════

    async upsert(progressData) {
        if (!progressData.courseId) throw new Error('courseId is required for progress upsert');
        if (!progressData.userId) throw new Error('userId is required for progress upsert');

        const isSubjectLevel = progressData.subjectId && Number(progressData.subjectId) > 0;
        const averageGrade = progressData.averageGrade ?? 0;

        const payload = {
            usuario_estudiante:  progressData.userId,
            curso_id:            progressData.courseId,
            materia_id:          isSubjectLevel ? Number(progressData.subjectId) : null,
            tareas_completadas:  progressData.completedTasks  || 0,
            tareas_totales:      progressData.totalTasks       || 0,
            promedio:            averageGrade,
            calificacion_ponderada: averageGrade,
            porcentaje_progreso: progressData.progressPercentage || 0,
            // estado es GENERATED ALWAYS en la BD — no incluir en el payload
            ultima_calculada_en: new Date().toISOString(),
        };

        // uq_progreso_unique es NULLS NOT DISTINCT → funciona con materia_id=null
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .upsert(payload, { onConflict: 'usuario_estudiante,curso_id,materia_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);

        const cert = isSubjectLevel
            ? null
            : await this._findCertificate(progressData.userId, progressData.courseId);
        return this._mapToDomain(data, cert);
    }

    async delete(userId, courseId, subjectId = null) {
        let query = this.client
            .from('progreso_estudiante')
            .delete()
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId);
        if (subjectId && Number(subjectId) > 0) {
            query = query.eq('materia_id', subjectId);
        } else {
            query = query.is('materia_id', null);
        }
        const { error } = await query;
        if (error) throw new Error(error.message);
        return true;
    }

    async getLeaderboard(courseId, limit = 10) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('curso_id', courseId)
            .is('materia_id', null)
            .order('porcentaje_progreso', { ascending: false })
            .limit(limit);
        if (error || !data?.length) return [];
        const userIds = data.map(r => r.usuario_estudiante);
        const certsMap = await this._fetchCertificatesMap([courseId], userIds);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${r.usuario_estudiante}-${courseId}`)));
    }

    async countByCourse(courseId) {
        const { count, error } = await this.client
            .from('progreso_estudiante')
            .select('id', { count: 'exact', head: true })
            .eq('curso_id', courseId)
            .is('materia_id', null);
        return error ? 0 : count;
    }

    async findEnrolledCourseIds(userId) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('curso_id')
            .eq('usuario_estudiante', userId)
            .is('materia_id', null);
        if (error || !data) return [];
        return data.map(p => p.curso_id);
    }

    async isEnrolled(userId, courseId) {
        const { count, error } = await this.client
            .from('progreso_estudiante')
            .select('id', { count: 'exact', head: true })
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .is('materia_id', null);
        return !error && count > 0;
    }

    async countEnrolled(userId) {
        const { count, error } = await this.client
            .from('progreso_estudiante')
            .select('id', { count: 'exact', head: true })
            .eq('usuario_estudiante', userId)
            .is('materia_id', null);
        return error ? 0 : count;
    }

    async findEnrolledCourseIdsPaginated(userId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('curso_id')
            .eq('usuario_estudiante', userId)
            .is('materia_id', null)
            .order('ultima_calculada_en', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data.map(p => p.curso_id);
    }

    async findWonProgressByCourseIds(courseIds) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, curso_id, promedio, calificacion_ponderada')
            .in('curso_id', courseIds)
            .is('materia_id', null)
            .eq('estado', 'Ganado')
            .not('usuario_estudiante', 'is', null);
        if (error) {
            console.error('[ProgressRepo] findWonProgressByCourseIds error:', error.message);
            return [];
        }
        return (data || []).map(row => ({
            userId: Number(row.usuario_estudiante),
            courseId: Number(row.curso_id),
            grade: Number(row.promedio ?? row.calificacion_ponderada ?? 0),
        }));
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESO POR MATERIA  (materia_id IS NOT NULL)
    // ═══════════════════════════════════════════════════════════════

    async findSubjectProgressByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .not('materia_id', 'is', null)
            .order('materia_id');
        if (error || !data) return [];
        return data.map(r => this._mapToDomain(r));
    }

    async findByUserAndSubject(userId, subjectId) {
        const { data, error } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('materia_id', subjectId)
            .single();
        if (error || !data) return null;
        return this._mapToDomain(data);
    }

    // ═══════════════════════════════════════════════════════════════
    //  CERTIFICADOS  (tabla: certificates)
    // ═══════════════════════════════════════════════════════════════

    async findCertificatesByUser(userId) {
        const { data, error } = await this.client
            .from('certificates')
            .select('course_id, issued_at, storage_path, verification_code')
            .eq('user_id', userId)
            .order('issued_at', { ascending: false });
        if (error || !data?.length) return [];

        const courseIds = data.map(r => r.course_id).filter(Boolean);

        // Validate: only return certificates that have a matching 'Ganado' progress record
        let validCourseIds = new Set();
        if (courseIds.length > 0) {
            const { data: progressRows } = await this.client
                .from('progreso_estudiante')
                .select('curso_id')
                .eq('usuario_estudiante', userId)
                .in('curso_id', courseIds)
                .is('materia_id', null)
                .eq('estado', 'Ganado');
            for (const row of progressRows || []) {
                validCourseIds.add(row.curso_id);
            }
        }

        const validData = data.filter(r => validCourseIds.has(r.course_id));
        if (validData.length === 0) return [];

        const validIds = validData.map(r => r.course_id);
        let coursesById = new Map();
        if (validIds.length > 0) {
            const { data: courses } = await this.client
                .from('courses')
                .select('id, title, thumbnail_uri')
                .in('id', validIds);
            coursesById = new Map((courses || []).map(c => [c.id, c]));
        }

        return validData.map(row => {
            const course = coursesById.get(row.course_id) || {};
            return {
                courseId:           row.course_id,
                courseName:         course.title || null,
                courseThumbnail:    course.thumbnail_uri || null,
                certificateUrl:     row.storage_path,
                certificateIssuedAt: row.issued_at,
                verificationCode:   row.verification_code,
                status:             'Ganado',
                averageGrade:       null,
            };
        });
    }

    /**
     * Emite o actualiza el certificado de (userId, courseId).
     * Lanza error si el progreso del curso no tiene estado='Ganado'.
     * Retorna el progreso del curso con la info del certificado adjunta.
     */
    async updateCertificate(userId, courseId, data) {
        // Verificar que el estudiante haya ganado el curso antes de emitir
        const { data: prog, error: progError } = await this.client
            .from('progreso_estudiante')
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .is('materia_id', null)
            .single();

        if (progError || !prog) {
            throw new Error(`El estudiante ${userId} no tiene progreso registrado para el curso ${courseId}`);
        }
        if (prog.estado !== 'Ganado') {
            throw new Error(`No se puede emitir el certificado: el estudiante ${userId} no ha ganado el curso ${courseId} (estado actual: ${prog.estado})`);
        }

        const payload = { user_id: userId, course_id: courseId };
        if (data.certificateIssuedAt) payload.issued_at    = data.certificateIssuedAt;
        if (data.certificateUrl)      payload.storage_path = data.certificateUrl;

        const { data: cert, error } = await this.client
            .from('certificates')
            .upsert(payload, { onConflict: 'user_id,course_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);

        return this._mapToDomain(prog, cert);
    }

    async bulkIssueCertificates(pairs) {
        if (!pairs?.length) return [];

        // Filtrar solo los pares donde el progreso del curso es 'Ganado'
        const courseIds = [...new Set(pairs.map(p => p.courseId))];
        const userIds   = [...new Set(pairs.map(p => p.userId))];

        const { data: wonRows, error: wonError } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, curso_id')
            .in('curso_id', courseIds)
            .in('usuario_estudiante', userIds)
            .is('materia_id', null)
            .eq('estado', 'Ganado');

        if (wonError) throw new Error(wonError.message);

        const wonSet = new Set((wonRows || []).map(r => `${r.usuario_estudiante}-${r.curso_id}`));
        const eligiblePairs = pairs.filter(({ userId, courseId }) => wonSet.has(`${userId}-${courseId}`));

        if (!eligiblePairs.length) return [];

        const now = new Date().toISOString();
        const results = [];
        for (const { userId, courseId } of eligiblePairs) {
            const { data, error } = await this.client
                .from('certificates')
                .upsert(
                    { user_id: userId, course_id: courseId, issued_at: now },
                    { onConflict: 'user_id,course_id', ignoreDuplicates: true }
                )
                .select()
                .maybeSingle();
            if (!error && data) results.push(data);
        }
        return results;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN / CREATOR
    // ═══════════════════════════════════════════════════════════════

    async getTopStudentsGlobal(limit = 5, creatorUserId = null) {
        const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 5;
        const creatorId = Number(creatorUserId);
        if (!Number.isInteger(creatorId) || creatorId <= 0) return [];

        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses').select('id').eq('creator_user_id', creatorId);
        if (coursesError || !creatorCourses?.length) return [];

        const courseIds = creatorCourses.map(c => c.id);
        const { data: progressRows, error: progressError } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, promedio, calificacion_ponderada')
            .in('curso_id', courseIds)
            .is('materia_id', null)
            .eq('estado', 'Ganado')
            .not('usuario_estudiante', 'is', null);
        if (progressError || !progressRows?.length) return [];

        const aggregated = new Map();
        for (const row of progressRows) {
            const userId = Number(row.usuario_estudiante);
            if (!Number.isInteger(userId) || userId <= 0) continue;
            const s = aggregated.get(userId) || {
                user_id: userId, approved_courses: 0,
                total_grade: 0, graded_courses: 0, average_grade: 0,
                username: null, avatar: null,
            };
            s.approved_courses += 1;
            const grade = Number(row.promedio ?? row.calificacion_ponderada);
            if (Number.isFinite(grade)) { s.total_grade += grade; s.graded_courses += 1; }
            aggregated.set(userId, s);
        }
        for (const s of aggregated.values()) {
            if (s.graded_courses > 0)
                s.average_grade = Number((s.total_grade / s.graded_courses).toFixed(2));
        }

        const ranked = [...aggregated.values()]
            .filter(s => s.approved_courses > 0)
            .sort((a, b) => {
                if (b.average_grade !== a.average_grade) return b.average_grade - a.average_grade;
                if (b.approved_courses !== a.approved_courses) return b.approved_courses - a.approved_courses;
                return a.user_id - b.user_id;
            })
            .slice(0, safeLimit);

        const studentIds = ranked.map(s => s.user_id);
        if (studentIds.length > 0) {
            const { data: usersData } = await this.client
                .from('usuarios').select('id, username, avatar').in('id', studentIds);
            const usersById = new Map((usersData || []).map(u => [Number(u.id), u]));
            for (const s of ranked) {
                const u = usersById.get(s.user_id);
                if (u?.username) s.username = u.username;
                if (u?.avatar)   s.avatar   = u.avatar;
            }
        }
        return ranked.map(s => ({
            user_id:         s.user_id,
            username:        s.username || `Usuario ${s.user_id}`,
            avatar:          s.avatar || null,
            approved_courses: s.approved_courses,
            average_grade:   s.average_grade,
        }));
    }

    async getCreatorEnrollmentAnalytics(creatorUserId, { weeklyDays = 7, monthlyMonths = 6 } = {}) {
        const safeWeeklyDays   = Number.isInteger(weeklyDays)   && weeklyDays   > 0 ? weeklyDays   : 7;
        const safeMonthlyMonths = Number.isInteger(monthlyMonths) && monthlyMonths > 0 ? monthlyMonths : 6;

        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses').select('id').eq('creator_user_id', creatorUserId);
        if (coursesError || !creatorCourses?.length)
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);

        const courseIds = creatorCourses.map(c => c.id);
        const { data: progressRows, error: progressError } = await this.client
            .from('progreso_estudiante')
            .select('creado_en, ultima_calculada_en')
            .in('curso_id', courseIds)
            .is('materia_id', null);
        if (progressError || !progressRows)
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);

        return this._aggregateCreatorEnrollmentAnalytics(progressRows, safeWeeklyDays, safeMonthlyMonths);
    }

    async findWonProgressByCreatorCourses(creatorUserId) {
        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses').select('id, title, thumbnail_uri').eq('creator_user_id', creatorUserId);
        if (coursesError || !creatorCourses?.length) return [];

        const courseIds = creatorCourses.map(c => c.id);
        const coursesById = new Map(creatorCourses.map(c => [c.id, c]));

        const { data: rows, error } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, curso_id, estado, promedio, calificacion_ponderada, tareas_completadas, tareas_totales, porcentaje_progreso')
            .in('curso_id', courseIds)
            .is('materia_id', null)
            .eq('estado', 'Ganado');
        if (error || !rows?.length) return [];

        const userIds = [...new Set(rows.map(r => r.usuario_estudiante).filter(Boolean))];
        const certsMap = await this._fetchCertificatesMap(courseIds, userIds);

        let usersById = new Map();
        if (userIds.length > 0) {
            const { data: users } = await this.client
                .from('usuarios').select('id, username, avatar').in('id', userIds);
            usersById = new Map((users || []).map(u => [u.id, u]));
        }

        return rows.map(row => {
            const course = coursesById.get(row.curso_id) || {};
            const user   = usersById.get(row.usuario_estudiante) || {};
            const cert   = certsMap.get(`${row.usuario_estudiante}-${row.curso_id}`);
            return {
                userId:             row.usuario_estudiante,
                username:           user.username || null,
                avatar:             user.avatar || null,
                courseId:           row.curso_id,
                courseName:         course.title || null,
                courseThumbnail:    course.thumbnail_uri || null,
                certificateUrl:     cert?.storage_path || null,
                certificateIssuedAt: cert?.issued_at || null,
                status:             row.estado,
                averageGrade:       row.promedio ?? row.calificacion_ponderada ?? null,
                completedTasks:     row.tareas_completadas || 0,
                totalTasks:         row.tareas_totales || 0,
                progressPercentage: row.porcentaje_progreso || 0,
            };
        });
    }

    async findAllWonProgress() {
        const { data: rows, error } = await this.client
            .from('progreso_estudiante')
            .select('usuario_estudiante, curso_id, estado, promedio, calificacion_ponderada, tareas_completadas, tareas_totales, porcentaje_progreso')
            .is('materia_id', null)
            .eq('estado', 'Ganado');
        if (error || !rows?.length) return [];

        const courseIds = [...new Set(rows.map(r => r.curso_id).filter(Boolean))];
        const userIds   = [...new Set(rows.map(r => r.usuario_estudiante).filter(Boolean))];
        const certsMap  = await this._fetchCertificatesMap(courseIds, userIds);

        let coursesById = new Map();
        if (courseIds.length > 0) {
            const { data: courses } = await this.client
                .from('courses').select('id, title, thumbnail_uri').in('id', courseIds);
            coursesById = new Map((courses || []).map(c => [c.id, c]));
        }
        let usersById = new Map();
        if (userIds.length > 0) {
            const { data: users } = await this.client
                .from('usuarios').select('id, username, avatar').in('id', userIds);
            usersById = new Map((users || []).map(u => [u.id, u]));
        }

        return rows.map(row => {
            const course = coursesById.get(row.curso_id) || {};
            const user   = usersById.get(row.usuario_estudiante) || {};
            const cert   = certsMap.get(`${row.usuario_estudiante}-${row.curso_id}`);
            return {
                userId:             row.usuario_estudiante,
                username:           user.username || null,
                avatar:             user.avatar || null,
                courseId:           row.curso_id,
                courseName:         course.title || null,
                courseThumbnail:    course.thumbnail_uri || null,
                certificateUrl:     cert?.storage_path || null,
                certificateIssuedAt: cert?.issued_at || null,
                status:             row.estado,
                averageGrade:       row.promedio ?? row.calificacion_ponderada ?? null,
                completedTasks:     row.tareas_completadas || 0,
                totalTasks:         row.tareas_totales || 0,
                progressPercentage: row.porcentaje_progreso || 0,
            };
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  PRE-ENROLLMENTS  (tabla: pre_enrollments — sin cambios)
    // ═══════════════════════════════════════════════════════════════

    async findPendingEnrollments(courseId = null) {
        let query = this.client
            .from('pre_enrollments')
            .select('user_id, course_id, status, requested_at')
            .eq('status', 'pending');
        if (courseId) query = query.eq('course_id', courseId);
        const { data, error } = await query.order('requested_at', { ascending: false });
        if (error || !data) return [];

        const userIds   = [...new Set(data.map(r => Number(r.user_id)).filter(id => Number.isInteger(id) && id > 0))];
        const courseIds = [...new Set(data.map(r => Number(r.course_id)).filter(id => Number.isInteger(id) && id > 0))];

        let usersById   = new Map();
        let personasById = new Map();
        let coursesById = new Map();

        if (userIds.length > 0) {
            const { data: users } = await this.client
                .from('usuarios').select('id, username, avatar, persona_id').in('id', userIds);
            usersById = new Map((users || []).map(u => [Number(u.id), u]));

            const personaIds = [...new Set((users || [])
                .map(u => Number(u.persona_id)).filter(id => Number.isInteger(id) && id > 0))];
            if (personaIds.length > 0) {
                const { data: personas } = await this.client
                    .from('personas').select('id, nombres, apellidos, identificacion').in('id', personaIds);
                personasById = new Map((personas || []).map(p => [Number(p.id), p]));
            }
        }
        if (courseIds.length > 0) {
            const { data: courses } = await this.client
                .from('courses').select('id, title').in('id', courseIds);
            coursesById = new Map((courses || []).map(c => [Number(c.id), c]));
        }

        return data.map(row => {
            const user    = usersById.get(Number(row.user_id)) || null;
            const persona = user?.persona_id ? personasById.get(Number(user.persona_id)) || null : null;
            const course  = coursesById.get(Number(row.course_id)) || null;
            return this._mapPreEnrollmentRecord(row, {
                username:   user?.username || null,
                avatar:     user?.avatar || null,
                fullName:   persona ? `${persona.nombres || ''} ${persona.apellidos || ''}`.trim() || null : null,
                identificacion: persona?.identificacion ?? null,
                courseName: course?.title || null,
            });
        });
    }

    async updateEnrollmentStatus(userId, courseId, status, reviewedBy = null) {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .update({
                status,
                reviewed_at: new Date().toISOString(),
                ...(reviewedBy ? { reviewed_by: reviewedBy } : {}),
            })
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._mapPreEnrollmentRecord(data);
    }

    async findPreEnrollment(userId, courseId) {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .select('*')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .maybeSingle();
        if (error || !data) return null;
        return this._mapPreEnrollmentRecord(data);
    }

    async upsertPreEnrollment(userId, courseId, status = 'pending') {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .upsert({
                user_id:      userId,
                course_id:    courseId,
                status,
                requested_at: new Date().toISOString(),
            }, { onConflict: 'user_id,course_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._mapPreEnrollmentRecord(data);
    }

    _mapPreEnrollmentRecord(record, extras = {}) {
        if (!record) return null;
        const status = record.enrollmentStatus || record.enrollment_status || record.status || null;
        return {
            userId:           record.userId     ?? record.user_id     ?? null,
            courseId:         record.courseId   ?? record.course_id   ?? null,
            status,
            enrollmentStatus:  status,
            enrollment_status: status,
            requestedAt:  record.requestedAt  || record.requested_at  || null,
            requested_at: record.requestedAt  || record.requested_at  || null,
            ...extras,
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS DE ANALYTICS  (sin cambios)
    // ═══════════════════════════════════════════════════════════════

    _buildEmptyCreatorEnrollmentAnalytics(weeklyDays, monthlyMonths) {
        const daily   = this._createDailyBuckets(weeklyDays);
        const monthly = this._createMonthlyBuckets(monthlyMonths);
        return {
            weekly:  { labels: daily.map(b => b.label),   values: daily.map(() => 0) },
            monthly: { labels: monthly.map(b => b.label), values: monthly.map(() => 0) },
            totalEnrollments: 0,
        };
    }

    _aggregateCreatorEnrollmentAnalytics(progressRows, weeklyDays, monthlyMonths) {
        const daily   = this._createDailyBuckets(weeklyDays);
        const monthly = this._createMonthlyBuckets(monthlyMonths);
        const dailyIdx   = new Map(daily.map((b, i) => [b.key, i]));
        const monthlyIdx = new Map(monthly.map((b, i) => [b.key, i]));

        for (const row of progressRows) {
            const raw = row.creado_en || row.ultima_calculada_en;
            if (!raw) continue;
            const d = new Date(raw);
            if (Number.isNaN(d.getTime())) continue;

            const di = dailyIdx.get(this._formatDayKeyUtc(d));
            if (di !== undefined) daily[di].count += 1;

            const mi = monthlyIdx.get(this._formatMonthKeyUtc(d));
            if (mi !== undefined) monthly[mi].count += 1;
        }
        return {
            weekly:  { labels: daily.map(b => b.label),   values: daily.map(b => b.count) },
            monthly: { labels: monthly.map(b => b.label), values: monthly.map(b => b.count) },
            totalEnrollments: progressRows.length,
        };
    }

    _createDailyBuckets(n) {
        const labels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const now    = new Date();
        return Array.from({ length: n }, (_, i) => {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (n - 1 - i)));
            return { key: this._formatDayKeyUtc(d), label: labels[d.getUTCDay()], count: 0 };
        });
    }

    _createMonthlyBuckets(n) {
        const labels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const now    = new Date();
        return Array.from({ length: n }, (_, i) => {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
            return { key: this._formatMonthKeyUtc(d), label: labels[d.getUTCMonth()], count: 0 };
        });
    }

    _formatDayKeyUtc(d) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    _formatMonthKeyUtc(d) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
}

export default SupabaseProgressRepository;
