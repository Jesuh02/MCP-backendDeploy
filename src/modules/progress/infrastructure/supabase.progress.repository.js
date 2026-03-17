export class SupabaseProgressRepository {
    constructor(client) { this.client = client; }

    // ─── Helpers privados ────────────────────────────────────────────────────

    /** Busca el certificado de (user, course). Retorna null si no existe. */
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
     * Carga certificados de múltiples (user, course) en una sola consulta.
     * Retorna un Map con clave `${userId}-${courseId}`.
     */
    async _fetchCertificatesMap(courseIds, userIds = null) {
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

    /** Mapea una fila de `progreso_curso` al objeto de dominio. */
    _mapCourseToDomain(row, cert = null) {
        if (!row) return null;
        return {
            userId: row.usuario_id,
            courseId: row.curso_id,
            subjectId: null,
            completedTasks: row.tareas_completadas,
            totalTasks: row.tareas_totales,
            averageGrade: row.promedio,
            progressPercentage: row.porcentaje_progreso,
            status: row.estado,
            enrollment_status: 'activo',
            lastActivityAt: row.ultima_calculada_en,
            certificateIssuedAt: cert?.issued_at || null,
            certificateUrl: cert?.storage_path || null,
        };
    }

    /** Mapea una fila de `progreso_materia` al objeto de dominio. */
    _mapSubjectToDomain(row) {
        if (!row) return null;
        return {
            userId: row.usuario_id,
            courseId: row.curso_id,
            subjectId: row.materia_id,
            completedTasks: row.tareas_completadas,
            totalTasks: row.tareas_totales,
            averageGrade: row.promedio,
            progressPercentage: row.porcentaje_progreso,
            status: row.promedio >= 6 ? 'Ganado' : 'Perdido',
            enrollment_status: 'activo',
            lastActivityAt: row.ultima_calculada_en,
            certificateIssuedAt: null,
            certificateUrl: null,
        };
    }

    // ─── Consultas sobre progreso_curso ──────────────────────────────────────

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('*')
            .eq('usuario_id', userId)
            .eq('curso_id', courseId)
            .single();
        if (error || !data) return null;
        const cert = await this._findCertificate(userId, courseId);
        return this._mapCourseToDomain(data, cert);
    }

    async findByUser(userId) {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('*')
            .eq('usuario_id', userId)
            .order('ultima_calculada_en', { ascending: false });
        if (error || !data?.length) return [];
        const courseIds = data.map(r => r.curso_id);
        const certsMap = await this._fetchCertificatesMap(courseIds, [userId]);
        return data.map(r => this._mapCourseToDomain(r, certsMap.get(`${r.usuario_id}-${r.curso_id}`)));
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('*')
            .eq('curso_id', courseId);
        if (error || !data?.length) return [];
        const userIds = data.map(r => r.usuario_id);
        const certsMap = await this._fetchCertificatesMap([courseId], userIds);
        return data.map(r => this._mapCourseToDomain(r, certsMap.get(`${r.usuario_id}-${r.curso_id}`)));
    }

    async findByCourseIds(courseIds = []) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('*')
            .in('curso_id', courseIds);
        if (error || !data?.length) return [];
        const certsMap = await this._fetchCertificatesMap(courseIds);
        return data.map(r => this._mapCourseToDomain(r, certsMap.get(`${r.usuario_id}-${r.curso_id}`)));
    }

    async findCourseEnrollmentRanking() {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('curso_id, usuario_id')
            .not('curso_id', 'is', null)
            .not('usuario_id', 'is', null);
        if (error || !data) return [];

        const usersByCourse = new Map();
        for (const row of data) {
            const courseId = Number(row.curso_id);
            const userId = Number(row.usuario_id);
            if (!Number.isInteger(courseId) || courseId <= 0) continue;
            if (!Number.isInteger(userId) || userId <= 0) continue;
            if (!usersByCourse.has(courseId)) usersByCourse.set(courseId, new Set());
            usersByCourse.get(courseId).add(userId);
        }

        return [...usersByCourse.entries()]
            .map(([courseId, users]) => ({ courseId, enrollmentCount: users.size }))
            .sort((a, b) => b.enrollmentCount - a.enrollmentCount || a.courseId - b.courseId);
    }

    // ─── Upsert (enruta a la tabla correcta según subjectId) ─────────────────

    async upsert(progressData) {
        if (!progressData.courseId) throw new Error('courseId is required for progress upsert');
        if (!progressData.userId) throw new Error('userId is required for progress upsert');

        const isSubjectLevel = progressData.subjectId && Number(progressData.subjectId) > 0;
        return isSubjectLevel
            ? this._upsertSubjectProgress(progressData)
            : this._upsertCourseProgress(progressData);
    }

    async _upsertCourseProgress(progressData) {
        const payload = {
            usuario_id: progressData.userId,
            curso_id: progressData.courseId,
            tareas_completadas: progressData.completedTasks || 0,
            tareas_totales: progressData.totalTasks || 0,
            promedio: progressData.averageGrade ?? 0,
            porcentaje_progreso: progressData.progressPercentage || 0,
            ultima_calculada_en: new Date().toISOString(),
        };
        const { data, error } = await this.client
            .from('progreso_curso')
            .upsert(payload, { onConflict: 'usuario_id,curso_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);
        const cert = await this._findCertificate(progressData.userId, progressData.courseId);
        return this._mapCourseToDomain(data, cert);
    }

    async _upsertSubjectProgress(progressData) {
        const payload = {
            usuario_id: progressData.userId,
            materia_id: progressData.subjectId,
            curso_id: progressData.courseId,
            tareas_completadas: progressData.completedTasks || 0,
            tareas_totales: progressData.totalTasks || 0,
            promedio: progressData.averageGrade ?? 0,
            porcentaje_progreso: progressData.progressPercentage || 0,
            ultima_calculada_en: new Date().toISOString(),
        };
        const { data, error } = await this.client
            .from('progreso_materia')
            .upsert(payload, { onConflict: 'usuario_id,materia_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._mapSubjectToDomain(data);
    }

    async delete(userId, courseId, subjectId = null) {
        if (subjectId && Number(subjectId) > 0) {
            const { error } = await this.client
                .from('progreso_materia')
                .delete()
                .eq('usuario_id', userId)
                .eq('materia_id', subjectId);
            if (error) throw new Error(error.message);
        } else {
            const { error } = await this.client
                .from('progreso_curso')
                .delete()
                .eq('usuario_id', userId)
                .eq('curso_id', courseId);
            if (error) throw new Error(error.message);
        }
        return true;
    }

    async getLeaderboard(courseId, limit = 10) {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('*')
            .eq('curso_id', courseId)
            .order('porcentaje_progreso', { ascending: false })
            .limit(limit);
        if (error || !data?.length) return [];
        const userIds = data.map(r => r.usuario_id);
        const certsMap = await this._fetchCertificatesMap([courseId], userIds);
        return data.map(r => this._mapCourseToDomain(r, certsMap.get(`${r.usuario_id}-${r.curso_id}`)));
    }

    async countByCourse(courseId) {
        const { count, error } = await this.client
            .from('progreso_curso')
            .select('usuario_id', { count: 'exact', head: true })
            .eq('curso_id', courseId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIds(userId) {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('curso_id')
            .eq('usuario_id', userId);
        if (error || !data) return [];
        return data.map(p => p.curso_id);
    }

    async isEnrolled(userId, courseId) {
        const { count, error } = await this.client
            .from('progreso_curso')
            .select('usuario_id', { count: 'exact', head: true })
            .eq('usuario_id', userId)
            .eq('curso_id', courseId);
        return !error && count > 0;
    }

    async countEnrolled(userId) {
        const { count, error } = await this.client
            .from('progreso_curso')
            .select('curso_id', { count: 'exact', head: true })
            .eq('usuario_id', userId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIdsPaginated(userId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('curso_id')
            .eq('usuario_id', userId)
            .order('ultima_calculada_en', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data.map(p => p.curso_id);
    }

    async findWonProgressByCourseIds(courseIds) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from('progreso_curso')
            .select('usuario_id, curso_id, promedio')
            .in('curso_id', courseIds)
            .eq('estado', 'Ganado')
            .not('usuario_id', 'is', null);
        if (error) {
            console.error('[ProgressRepo] findWonProgressByCourseIds error:', error.message);
            return [];
        }
        return (data || []).map(row => ({
            userId: Number(row.usuario_id),
            courseId: Number(row.curso_id),
            grade: Number(row.promedio ?? 0),
        }));
    }

    // ─── Certificados ─────────────────────────────────────────────────────────

    async findCertificatesByUser(userId) {
        const { data, error } = await this.client
            .from('certificates')
            .select('course_id, issued_at, storage_path, verification_code')
            .eq('user_id', userId)
            .order('issued_at', { ascending: false });
        if (error || !data?.length) return [];

        const courseIds = data.map(r => r.course_id).filter(Boolean);
        let coursesById = new Map();
        if (courseIds.length > 0) {
            const { data: courses } = await this.client
                .from('courses')
                .select('id, title, thumbnail_uri')
                .in('id', courseIds);
            coursesById = new Map((courses || []).map(c => [c.id, c]));
        }

        return data.map(row => {
            const course = coursesById.get(row.course_id) || {};
            return {
                courseId: row.course_id,
                courseName: course.title || null,
                courseThumbnail: course.thumbnail_uri || null,
                certificateUrl: row.storage_path,
                certificateIssuedAt: row.issued_at,
                verificationCode: row.verification_code,
                status: 'Ganado',
                averageGrade: null,
            };
        });
    }

    /**
     * Emite o actualiza un certificado.
     * Almacena el path relativo (storage_path), no la URL completa.
     * Retorna el progreso del curso con info del certificado adjunta.
     */
    async updateCertificate(userId, courseId, data) {
        const payload = { user_id: userId, course_id: courseId };
        if (data.certificateIssuedAt) payload.issued_at = data.certificateIssuedAt;
        if (data.certificateUrl) payload.storage_path = data.certificateUrl;

        const { data: cert, error } = await this.client
            .from('certificates')
            .upsert(payload, { onConflict: 'user_id,course_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);

        const { data: prog } = await this.client
            .from('progreso_curso')
            .select('*')
            .eq('usuario_id', userId)
            .eq('curso_id', courseId)
            .single();

        return this._mapCourseToDomain(prog, cert);
    }

    async bulkIssueCertificates(pairs) {
        const now = new Date().toISOString();
        const results = [];
        for (const { userId, courseId } of pairs) {
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

    // ─── Consultas sobre progreso_materia ────────────────────────────────────

    async findSubjectProgressByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('progreso_materia')
            .select('*')
            .eq('usuario_id', userId)
            .eq('curso_id', courseId)
            .order('materia_id');
        if (error || !data) return [];
        return data.map(r => this._mapSubjectToDomain(r));
    }

    async findByUserAndSubject(userId, subjectId) {
        const { data, error } = await this.client
            .from('progreso_materia')
            .select('*')
            .eq('usuario_id', userId)
            .eq('materia_id', subjectId)
            .single();
        if (error || !data) return null;
        return this._mapSubjectToDomain(data);
    }

    // ─── Admin / Creator queries ──────────────────────────────────────────────

    async getTopStudentsGlobal(limit = 5, creatorUserId = null) {
        const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 5;
        const creatorId = Number(creatorUserId);
        if (!Number.isInteger(creatorId) || creatorId <= 0) return [];

        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses')
            .select('id')
            .eq('creator_user_id', creatorId);
        if (coursesError || !creatorCourses?.length) return [];

        const courseIds = creatorCourses.map(c => c.id);
        const { data: progressRows, error: progressError } = await this.client
            .from('progreso_curso')
            .select('usuario_id, estado, promedio')
            .in('curso_id', courseIds)
            .eq('estado', 'Ganado')
            .not('usuario_id', 'is', null);
        if (progressError || !progressRows?.length) return [];

        const aggregated = new Map();
        for (const row of progressRows) {
            const userId = Number(row.usuario_id);
            if (!Number.isInteger(userId) || userId <= 0) continue;
            const existing = aggregated.get(userId) || {
                user_id: userId, approved_courses: 0, total_grade: 0,
                graded_courses: 0, average_grade: 0, username: null, avatar: null,
            };
            existing.approved_courses += 1;
            const grade = Number(row.promedio);
            if (Number.isFinite(grade)) { existing.total_grade += grade; existing.graded_courses += 1; }
            aggregated.set(userId, existing);
        }

        for (const s of aggregated.values()) {
            if (s.graded_courses > 0) {
                s.average_grade = Number((s.total_grade / s.graded_courses).toFixed(2));
            }
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
                if (u?.avatar) s.avatar = u.avatar;
            }
        }

        return ranked.map(s => ({
            user_id: s.user_id,
            username: s.username || `Usuario ${s.user_id}`,
            avatar: s.avatar || null,
            approved_courses: s.approved_courses,
            average_grade: s.average_grade,
        }));
    }

    async getCreatorEnrollmentAnalytics(creatorUserId, { weeklyDays = 7, monthlyMonths = 6 } = {}) {
        const safeWeeklyDays = Number.isInteger(weeklyDays) && weeklyDays > 0 ? weeklyDays : 7;
        const safeMonthlyMonths = Number.isInteger(monthlyMonths) && monthlyMonths > 0 ? monthlyMonths : 6;

        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses').select('id').eq('creator_user_id', creatorUserId);
        if (coursesError || !creatorCourses?.length) {
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);
        }

        const courseIds = creatorCourses.map(c => c.id);
        const { data: progressRows, error: progressError } = await this.client
            .from('progreso_curso')
            .select('creado_en, ultima_calculada_en')
            .in('curso_id', courseIds);

        if (progressError || !progressRows) {
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);
        }

        return this._aggregateCreatorEnrollmentAnalytics(progressRows, safeWeeklyDays, safeMonthlyMonths);
    }

    async findWonProgressByCreatorCourses(creatorUserId) {
        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses').select('id, title, thumbnail_uri').eq('creator_user_id', creatorUserId);
        if (coursesError || !creatorCourses?.length) return [];

        const courseIds = creatorCourses.map(c => c.id);
        const coursesById = new Map(creatorCourses.map(c => [c.id, c]));

        const { data: rows, error } = await this.client
            .from('progreso_curso')
            .select('usuario_id, curso_id, estado, promedio, tareas_completadas, tareas_totales, porcentaje_progreso')
            .in('curso_id', courseIds)
            .eq('estado', 'Ganado');
        if (error || !rows?.length) return [];

        const userIds = [...new Set(rows.map(r => r.usuario_id).filter(Boolean))];
        const certsMap = await this._fetchCertificatesMap(courseIds, userIds);

        let usersById = new Map();
        if (userIds.length > 0) {
            const { data: users } = await this.client
                .from('usuarios').select('id, username, avatar').in('id', userIds);
            usersById = new Map((users || []).map(u => [u.id, u]));
        }

        return rows.map(row => {
            const course = coursesById.get(row.curso_id) || {};
            const user = usersById.get(row.usuario_id) || {};
            const cert = certsMap.get(`${row.usuario_id}-${row.curso_id}`);
            return {
                userId: row.usuario_id,
                username: user.username || null,
                avatar: user.avatar || null,
                courseId: row.curso_id,
                courseName: course.title || null,
                courseThumbnail: course.thumbnail_uri || null,
                certificateUrl: cert?.storage_path || null,
                certificateIssuedAt: cert?.emitido_en || null,
                status: row.estado,
                averageGrade: row.promedio ?? null,
                completedTasks: row.tareas_completadas || 0,
                totalTasks: row.tareas_totales || 0,
                progressPercentage: row.porcentaje_progreso || 0,
            };
        });
    }

    async findAllWonProgress() {
        const { data: rows, error } = await this.client
            .from('progreso_curso')
            .select('usuario_id, curso_id, estado, promedio, tareas_completadas, tareas_totales, porcentaje_progreso')
            .eq('estado', 'Ganado');
        if (error || !rows?.length) return [];

        const courseIds = [...new Set(rows.map(r => r.curso_id).filter(Boolean))];
        const userIds = [...new Set(rows.map(r => r.usuario_id).filter(Boolean))];
        const certsMap = await this._fetchCertificatesMap(courseIds, userIds);

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
            const user = usersById.get(row.usuario_id) || {};
            const cert = certsMap.get(`${row.usuario_id}-${row.curso_id}`);
            return {
                userId: row.usuario_id,
                username: user.username || null,
                avatar: user.avatar || null,
                courseId: row.curso_id,
                courseName: course.title || null,
                courseThumbnail: course.thumbnail_uri || null,
                certificateUrl: cert?.storage_path || null,
                certificateIssuedAt: cert?.emitido_en || null,
                status: row.estado,
                averageGrade: row.promedio ?? null,
                completedTasks: row.tareas_completadas || 0,
                totalTasks: row.tareas_totales || 0,
                progressPercentage: row.porcentaje_progreso || 0,
            };
        });
    }

    // ─── Pre-enrollments (sin cambios respecto al esquema original) ──────────

    async findPendingEnrollments(courseId = null) {
        let query = this.client
            .from('pre_enrollments')
            .select('user_id, course_id, status, requested_at')
            .eq('status', 'pending');
        if (courseId) query = query.eq('course_id', courseId);
        const { data, error } = await query.order('requested_at', { ascending: false });
        if (error || !data) return [];

        const userIds = [...new Set(data.map(r => Number(r.user_id)).filter(id => Number.isInteger(id) && id > 0))];
        const courseIds = [...new Set(data.map(r => Number(r.course_id)).filter(id => Number.isInteger(id) && id > 0))];

        let usersById = new Map();
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
                    .from('personas').select('id, nombres, apellidos').in('id', personaIds);
                personasById = new Map((personas || []).map(p => [Number(p.id), p]));
            }
        }

        if (courseIds.length > 0) {
            const { data: courses } = await this.client
                .from('courses').select('id, title').in('id', courseIds);
            coursesById = new Map((courses || []).map(c => [Number(c.id), c]));
        }

        return data.map(row => {
            const user = usersById.get(Number(row.user_id)) || null;
            const persona = user?.persona_id ? personasById.get(Number(user.persona_id)) || null : null;
            const course = coursesById.get(Number(row.course_id)) || null;
            return this._mapPreEnrollmentRecord(row, {
                username: user?.username || null,
                avatar: user?.avatar || null,
                fullName: persona ? `${persona.nombres || ''} ${persona.apellidos || ''}`.trim() || null : null,
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
                user_id: userId,
                course_id: courseId,
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
            userId: record.userId ?? record.user_id ?? null,
            courseId: record.courseId ?? record.course_id ?? null,
            status,
            enrollmentStatus: status,
            enrollment_status: status,
            requestedAt: record.requestedAt || record.requested_at || null,
            requested_at: record.requestedAt || record.requested_at || null,
            ...extras,
        };
    }

    // ─── Helpers de analytics (sin cambios) ──────────────────────────────────

    _buildEmptyCreatorEnrollmentAnalytics(weeklyDays, monthlyMonths) {
        const dailyBuckets = this._createDailyBuckets(weeklyDays);
        const monthlyBuckets = this._createMonthlyBuckets(monthlyMonths);
        return {
            weekly: {
                labels: dailyBuckets.map(b => b.label),
                values: dailyBuckets.map(() => 0),
            },
            monthly: {
                labels: monthlyBuckets.map(b => b.label),
                values: monthlyBuckets.map(() => 0),
            },
            totalEnrollments: 0,
        };
    }

    _aggregateCreatorEnrollmentAnalytics(progressRows, weeklyDays, monthlyMonths) {
        const dailyBuckets = this._createDailyBuckets(weeklyDays);
        const monthlyBuckets = this._createMonthlyBuckets(monthlyMonths);
        const dailyIndexByKey = new Map(dailyBuckets.map((b, i) => [b.key, i]));
        const monthlyIndexByKey = new Map(monthlyBuckets.map((b, i) => [b.key, i]));

        for (const row of progressRows) {
            const rawDate = row.creado_en || row.ultima_calculada_en;
            if (!rawDate) continue;
            const enrollmentDate = new Date(rawDate);
            if (Number.isNaN(enrollmentDate.getTime())) continue;

            const dayKey = this._formatDayKeyUtc(enrollmentDate);
            const dayIndex = dailyIndexByKey.get(dayKey);
            if (dayIndex !== undefined) dailyBuckets[dayIndex].count += 1;

            const monthKey = this._formatMonthKeyUtc(enrollmentDate);
            const monthIndex = monthlyIndexByKey.get(monthKey);
            if (monthIndex !== undefined) monthlyBuckets[monthIndex].count += 1;
        }

        return {
            weekly: {
                labels: dailyBuckets.map(b => b.label),
                values: dailyBuckets.map(b => b.count),
            },
            monthly: {
                labels: monthlyBuckets.map(b => b.label),
                values: monthlyBuckets.map(b => b.count),
            },
            totalEnrollments: progressRows.length,
        };
    }

    _createDailyBuckets(weeklyDays) {
        const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const now = new Date();
        const buckets = [];
        for (let offset = weeklyDays - 1; offset >= 0; offset--) {
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
            buckets.push({ key: this._formatDayKeyUtc(date), label: dayLabels[date.getUTCDay()], count: 0 });
        }
        return buckets;
    }

    _createMonthlyBuckets(monthlyMonths) {
        const monthLabels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const now = new Date();
        const buckets = [];
        for (let offset = monthlyMonths - 1; offset >= 0; offset--) {
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
            buckets.push({ key: this._formatMonthKeyUtc(date), label: monthLabels[date.getUTCMonth()], count: 0 });
        }
        return buckets;
    }

    _formatDayKeyUtc(date) {
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }

    _formatMonthKeyUtc(date) {
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    }
}

export default SupabaseProgressRepository;
