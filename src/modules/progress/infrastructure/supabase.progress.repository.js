export class SupabaseProgressRepository {
    constructor(client) { this.client = client; }

    static COURSE_PROGRESS_TABLE = 'progreso_curso';
    static SUBJECT_PROGRESS_TABLE = 'progreso_materia';
    static CERTIFICATE_WEB_BASE_URL = process.env.CERTIFICATE_WEB_BASE_URL || 'https://v0-eo-jesuh02s-projects.vercel.app';

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS PRIVADOS
    // ═══════════════════════════════════════════════════════════════

    _courseProgressTable() {
        return SupabaseProgressRepository.COURSE_PROGRESS_TABLE;
    }

    _subjectProgressTable() {
        return SupabaseProgressRepository.SUBJECT_PROGRESS_TABLE;
    }

    _isSubjectLevel(subjectId) {
        return Number(subjectId) > 0;
    }

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

    _formatCertificateDate(dateLike) {
        const date = dateLike ? new Date(dateLike) : new Date();
        if (Number.isNaN(date.getTime())) return null;
        const day = String(date.getUTCDate()).padStart(2, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const year = String(date.getUTCFullYear());
        return `${day}/${month}/${year}`;
    }

    _buildSyntheticCertificateUrl({
        studentName,
        courseName,
        grade,
        tasksCompleted,
        totalTasks,
        progressPercentage,
        instructorName,
        instructorUsername,
        userId,
        courseId,
        verificationCode,
        issuedAt,
    }) {
        const safeStudentName = String(studentName || `Usuario ${userId}`).trim();
        const safeCourseName = String(courseName || `Curso ${courseId}`).trim();
        const safeInstructorUsername = String(instructorUsername || 'coursev').trim().replace(/^@+/, '');
        const safeInstructorName = String(instructorName || safeInstructorUsername || 'CourseV').trim();
        const safeGrade = Number.isFinite(Number(grade)) ? Number(grade) : 0;
        const safeTasksCompleted = Number.isFinite(Number(tasksCompleted)) ? Number(tasksCompleted) : 0;
        const safeTotalTasks = Number.isFinite(Number(totalTasks)) ? Number(totalTasks) : 0;
        const safeProgress = Number.isFinite(Number(progressPercentage)) ? Number(progressPercentage) : 0;
        const certId = String(verificationCode || `CERT-${courseId}-${userId}`).trim();
        const date = this._formatCertificateDate(issuedAt) || this._formatCertificateDate(new Date().toISOString());

        const params = new URLSearchParams({
            studentName: safeStudentName,
            courseName: safeCourseName,
            grade: safeGrade.toFixed(1),
            tasksCompleted: String(safeTasksCompleted),
            totalTasks: String(safeTotalTasks),
            progress: String(Math.round(safeProgress)),
            instructorName: safeInstructorName,
            instructorUsername: safeInstructorUsername,
            userId: String(userId),
            courseId: String(courseId),
            certId,
            date: date || '',
        });

        return `${SupabaseProgressRepository.CERTIFICATE_WEB_BASE_URL}?${params.toString()}`;
    }

    _resolveCertificateAccessUrl(cert, fallbackData = null) {
        const storedPath = String(cert?.storage_path || '').trim();
        if (storedPath) return storedPath;
        if (!cert?.issued_at || !fallbackData) return null;
        return this._buildSyntheticCertificateUrl({
            ...fallbackData,
            verificationCode: cert?.verification_code || fallbackData?.verificationCode || null,
            issuedAt: cert?.issued_at,
        });
    }

    /**
     * Fetches user/course/creator data from DB and builds the synthetic certificate URL.
     * Used when issuing a certificate without a pre-built URL.
     */
    async _buildCertificateUrlFromDb(userId, courseId, progressRow, verificationCode, issuedAt) {
        try {
            const [{ data: studentUser }, { data: courseRow }] = await Promise.all([
                this.client.from('usuarios').select('username').eq('id', userId).maybeSingle(),
                this.client.from('courses').select('title, creator_user_id').eq('id', courseId).maybeSingle(),
            ]);
            let instructorUsername = null;
            if (courseRow?.creator_user_id) {
                const { data: creator } = await this.client
                    .from('usuarios').select('username').eq('id', courseRow.creator_user_id).maybeSingle();
                instructorUsername = creator?.username || null;
            }
            return this._buildSyntheticCertificateUrl({
                studentName:        studentUser?.username || null,
                courseName:         courseRow?.title || null,
                grade:              progressRow?.promedio ?? progressRow?.calificacion_ponderada ?? null,
                tasksCompleted:     progressRow?.tareas_completadas ?? 0,
                totalTasks:         progressRow?.tareas_totales ?? 0,
                progressPercentage: progressRow?.porcentaje_progreso ?? 0,
                instructorName:     instructorUsername,
                instructorUsername,
                userId,
                courseId,
                verificationCode,
                issuedAt,
            });
        } catch {
            return null;
        }
    }

    /** Mapea una fila de progreso al objeto de dominio. */
    _mapToDomain(row, cert = null) {
        if (!row) return null;
        return {
            userId: row.usuario_estudiante,
            courseId: row.curso_id,
            subjectId: row.materia_id ?? null,
            completedTasks: row.tareas_completadas,
            totalTasks: row.tareas_totales,
            averageGrade: row.promedio ?? row.calificacion_ponderada ?? null,
            progressPercentage: row.porcentaje_progreso,
            status: row.estado,
            enrollment_status: row.enrollment_status ?? 'activo',
            lastActivityAt: row.ultima_calculada_en,
            certificateIssuedAt: cert?.issued_at || null,
            certificateUrl: cert?.storage_path || null,
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESO DEL CURSO
    // ═══════════════════════════════════════════════════════════════

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .single();
        if (error || !data) return null;
        const cert = await this._findCertificate(userId, courseId);
        return this._mapToDomain(data, cert);
    }

    async findByUser(userId) {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('*')
            .eq('usuario_estudiante', userId)
            .order('ultima_calculada_en', { ascending: false });
        if (error || !data?.length) return [];
        const courseIds = data.map(r => r.curso_id);
        const certsMap = await this._fetchCertificatesMap(courseIds, [userId]);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${userId}-${r.curso_id}`)));
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('*')
            .eq('curso_id', courseId);
        if (error || !data?.length) return [];
        const userIds = data.map(r => r.usuario_estudiante);
        const certsMap = await this._fetchCertificatesMap([courseId], userIds);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${r.usuario_estudiante}-${courseId}`)));
    }

    async findByCourseIds(courseIds = []) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('*')
            .in('curso_id', courseIds);
        if (error || !data?.length) return [];
        const certsMap = await this._fetchCertificatesMap(courseIds);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${r.usuario_estudiante}-${r.curso_id}`)));
    }

    async findCourseEnrollmentRanking() {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('curso_id, usuario_estudiante')
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

        const isSubjectLevel = this._isSubjectLevel(progressData.subjectId);
        const averageGrade = progressData.averageGrade ?? 0;
        const tableName = isSubjectLevel ? this._subjectProgressTable() : this._courseProgressTable();

        const payload = {
            usuario_estudiante:  progressData.userId,
            curso_id:            progressData.courseId,
            tareas_completadas:  progressData.completedTasks  || 0,
            tareas_totales:      progressData.totalTasks       || 0,
            promedio:            averageGrade,
            calificacion_ponderada: averageGrade,
            porcentaje_progreso: progressData.progressPercentage || 0,
            ultima_calculada_en: new Date().toISOString(),
            ...(isSubjectLevel ? { materia_id: Number(progressData.subjectId) } : {}),
            ...(!isSubjectLevel && progressData.enrollment_status ? { enrollment_status: progressData.enrollment_status } : {}),
        };

        const { data, error } = await this.client
            .from(tableName)
            .upsert(payload, {
                onConflict: isSubjectLevel
                    ? 'usuario_estudiante,curso_id,materia_id'
                    : 'usuario_estudiante,curso_id',
            })
            .select()
            .single();
        if (error) throw new Error(error.message);

        const cert = isSubjectLevel
            ? null
            : await this._findCertificate(progressData.userId, progressData.courseId);
        return this._mapToDomain(data, cert);
    }

    async delete(userId, courseId, subjectId = null) {
        const isSubjectLevel = this._isSubjectLevel(subjectId);
        let query = this.client
            .from(isSubjectLevel ? this._subjectProgressTable() : this._courseProgressTable())
            .delete()
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId);
        if (isSubjectLevel) query = query.eq('materia_id', Number(subjectId));
        const { error } = await query;
        if (error) throw new Error(error.message);
        return true;
    }

    async getLeaderboard(courseId, limit = 10) {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('*')
            .eq('curso_id', courseId)
            .order('porcentaje_progreso', { ascending: false })
            .limit(limit);
        if (error || !data?.length) return [];
        const userIds = data.map(r => r.usuario_estudiante);
        const certsMap = await this._fetchCertificatesMap([courseId], userIds);
        return data.map(r => this._mapToDomain(r, certsMap.get(`${r.usuario_estudiante}-${courseId}`)));
    }

    async countByCourse(courseId) {
        const { count, error } = await this.client
            .from(this._courseProgressTable())
            .select('id', { count: 'exact', head: true })
            .eq('curso_id', courseId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIds(userId) {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('curso_id')
            .eq('usuario_estudiante', userId);
        if (error || !data) return [];
        return data.map(p => p.curso_id);
    }

    async findApprovedEnrollmentCourseIds(userId) {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .select('course_id')
            .eq('user_id', userId)
            .eq('status', 'approved')
            .order('requested_at', { ascending: false });
        if (error || !data) return [];
        return data
            .map((row) => Number(row.course_id))
            .filter((courseId) => Number.isInteger(courseId) && courseId > 0);
    }

    async isEnrolled(userId, courseId) {
        const { count, error } = await this.client
            .from(this._courseProgressTable())
            .select('id', { count: 'exact', head: true })
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId);
        return !error && count > 0;
    }

    async countEnrolled(userId) {
        const { count, error } = await this.client
            .from(this._courseProgressTable())
            .select('id', { count: 'exact', head: true })
            .eq('usuario_estudiante', userId);
        return error ? 0 : count;
    }

    async findEnrolledCourseIdsPaginated(userId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('curso_id')
            .eq('usuario_estudiante', userId)
            .order('ultima_calculada_en', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) return [];
        return data.map(p => p.curso_id);
    }

    async findWonProgressByCourseIds(courseIds) {
        if (!Array.isArray(courseIds) || courseIds.length === 0) return [];
        const { data, error } = await this.client
            .from(this._courseProgressTable())
            .select('usuario_estudiante, curso_id, promedio, calificacion_ponderada')
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
            grade: Number(row.promedio ?? row.calificacion_ponderada ?? 0),
        }));
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESO POR MATERIA
    // ═══════════════════════════════════════════════════════════════

    async findSubjectProgressByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from(this._subjectProgressTable())
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .order('materia_id');
        if (error || !data) return [];
        return data.map(r => this._mapToDomain(r));
    }

    async findByUserAndSubject(userId, subjectId) {
        const { data, error } = await this.client
            .from(this._subjectProgressTable())
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('materia_id', subjectId)
            .single();
        if (error || !data) return null;
        return this._mapToDomain(data);
    }

    /**
     * Admin: devuelve TODO el progreso por materia, enriquecido con info del usuario,
     * persona (identificacion), nombre del curso y nombre de la materia.
     * Si se pasa `creatorUserId`, filtra solo los cursos de ese creador.
     */
    async findAllSubjectProgressForAdmin(creatorUserId = null) {
        // 1. Base query
        let query = this.client
            .from(this._subjectProgressTable())
            .select('usuario_estudiante, curso_id, materia_id, tareas_completadas, tareas_totales, promedio, calificacion_ponderada, porcentaje_progreso, ultima_calculada_en')
            .order('curso_id')
            .order('materia_id')
            .order('usuario_estudiante');

        const { data: rows, error } = await query;
        if (error || !rows?.length) return [];

        // 2. Si hay filtro por creador, obtener sus cursos
        let allowedCourseIds = null;
        if (creatorUserId) {
            const { data: creatorCourses } = await this.client
                .from('courses')
                .select('id')
                .eq('creator_user_id', creatorUserId);
            allowedCourseIds = new Set((creatorCourses || []).map(c => Number(c.id)));
            if (allowedCourseIds.size === 0) return [];
        }

        const filtered = allowedCourseIds
            ? rows.filter(r => allowedCourseIds.has(Number(r.curso_id)))
            : rows;
        if (!filtered.length) return [];

        // 3. Cargar dimensiones en paralelo
        const courseIds   = [...new Set(filtered.map(r => r.curso_id))];
        const subjectIds  = [...new Set(filtered.map(r => r.materia_id).filter(Boolean))];
        const userIds     = [...new Set(filtered.map(r => r.usuario_estudiante))];

        const [coursesRes, subjectsRes, usersRes, personasRes] = await Promise.all([
            courseIds.length
                ? this.client.from('courses').select('id, title').in('id', courseIds)
                : Promise.resolve({ data: [] }),
            subjectIds.length
                ? this.client.from('subjects').select('id, name').in('id', subjectIds)
                : Promise.resolve({ data: [] }),
            userIds.length
                ? this.client.from('usuarios').select('id, username, avatar').in('id', userIds)
                : Promise.resolve({ data: [] }),
            userIds.length
                ? this.client
                    .from('personas')
                    .select('id, nombres, apellidos, identificacion, identificacion_original')
                    .in('id',
                        // personas.id == usuario.persona_id — join via usuarios
                        await this.client
                            .from('usuarios')
                            .select('persona_id')
                            .in('id', userIds)
                            .then(({ data: u }) => (u || []).map(x => x.persona_id).filter(Boolean))
                    )
                : Promise.resolve({ data: [] }),
        ]);

        const coursesById  = new Map((coursesRes.data  || []).map(c => [Number(c.id), c]));
        const subjectsById = new Map((subjectsRes.data || []).map(s => [Number(s.id), s]));
        const usersById    = new Map((usersRes.data    || []).map(u => [Number(u.id), u]));

        // Build persona lookup keyed by usuario.id after fetching persona_id mapping
        const { data: userPersonaRows } = await this.client
            .from('usuarios')
            .select('id, persona_id')
            .in('id', userIds);
        const personaIdByUserId = new Map((userPersonaRows || []).map(u => [Number(u.id), Number(u.persona_id)]));
        const personasById = new Map((personasRes.data || []).map(p => [Number(p.id), p]));

        return filtered.map(r => {
            const userId    = Number(r.usuario_estudiante);
            const courseId  = Number(r.curso_id);
            const subjectId = r.materia_id ? Number(r.materia_id) : null;

            const user    = usersById.get(userId)    || {};
            const course  = coursesById.get(courseId)  || {};
            const subject = subjectId ? subjectsById.get(subjectId) || {} : {};

            const personaId = personaIdByUserId.get(userId);
            const persona   = personaId ? (personasById.get(personaId) || {}) : {};

            const grade = r.promedio ?? r.calificacion_ponderada ?? null;
            const pct   = Number(r.porcentaje_progreso) || 0;

            return {
                userId,
                username:        user.username     || `Usuario ${userId}`,
                avatar:          user.avatar        || null,
                nombres:         persona.nombres    || null,
                apellidos:       persona.apellidos  || null,
                identificacion:  persona.identificacion?.toString() || persona.identificacion_original || null,
                courseId,
                courseName:      course.title       || `Curso ${courseId}`,
                subjectId,
                subjectName:     subject.name       || (subjectId ? `Materia ${subjectId}` : 'Sin materia'),
                completedTasks:  Number(r.tareas_completadas) || 0,
                totalTasks:      Number(r.tareas_totales)     || 0,
                averageGrade:    grade !== null ? Number(grade) : null,
                progressPercentage: pct,
                lastActivityAt:  r.ultima_calculada_en || null,
            };
        });
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
                .from(this._courseProgressTable())
                .select('curso_id')
                .eq('usuario_estudiante', userId)
                .in('curso_id', courseIds)
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
                .select('id, title, thumbnail_uri, creator_user_id')
                .in('id', validIds);
            coursesById = new Map((courses || []).map(c => [c.id, c]));
        }

        let studentUsername = null;
        const { data: studentUser } = await this.client
            .from('usuarios')
            .select('id, username')
            .eq('id', userId)
            .maybeSingle();
        studentUsername = studentUser?.username || null;

        const creatorIds = [...new Set(validIds
            .map(courseId => coursesById.get(courseId)?.creator_user_id)
            .filter(Boolean))];
        let creatorsById = new Map();
        if (creatorIds.length > 0) {
            const { data: creators } = await this.client
                .from('usuarios')
                .select('id, username')
                .in('id', creatorIds);
            creatorsById = new Map((creators || []).map(c => [c.id, c]));
        }

        return validData.map(row => {
            const course = coursesById.get(row.course_id) || {};
            const creator = creatorsById.get(course.creator_user_id) || {};
            return {
                courseId:           row.course_id,
                courseName:         course.title || null,
                courseThumbnail:    course.thumbnail_uri || null,
                certificateUrl:     this._resolveCertificateAccessUrl(row, {
                    studentName: studentUsername,
                    courseName: course.title,
                    grade: null,
                    tasksCompleted: 0,
                    totalTasks: 0,
                    progressPercentage: 100,
                    instructorName: creator.username,
                    instructorUsername: creator.username,
                    userId,
                    courseId: row.course_id,
                    verificationCode: row.verification_code,
                }),
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
        const { data: progressRow, error: progError } = await this.client
            .from(SupabaseProgressRepository.COURSE_PROGRESS_TABLE)
            .select('*')
            .eq('usuario_estudiante', userId)
            .eq('curso_id', courseId)
            .maybeSingle();

        if (progError || !progressRow) {
            throw new Error(`El estudiante ${userId} no tiene progreso registrado para el curso ${courseId}`);
        }

        if (String(progressRow?.estado || '').trim().toLowerCase() !== 'ganado') {
            throw new Error(`No se puede emitir el certificado: el estudiante ${userId} no ha ganado el curso ${courseId} (estado actual: ${progressRow?.estado || 'desconocido'})`);
        }

        const payload = { user_id: userId, course_id: courseId };
        if (data.certificateIssuedAt) payload.issued_at    = data.certificateIssuedAt;
        if (data.certificateUrl)      payload.storage_path = data.certificateUrl;

        // Preserve existing verification_code on re-issue; generate a new one on first issue
        const { data: existingCert } = await this.client
            .from('certificates')
            .select('verification_code, storage_path')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .maybeSingle();
        payload.verification_code = existingCert?.verification_code
            || `CERT-${userId}-${courseId}-${Date.now().toString(36).toUpperCase()}`;

        // Generate and persist the synthetic URL if no storage_path is set yet
        if (!payload.storage_path && !existingCert?.storage_path) {
            const syntheticUrl = await this._buildCertificateUrlFromDb(
                userId, courseId, progressRow, payload.verification_code,
                payload.issued_at || new Date().toISOString()
            );
            if (syntheticUrl) payload.storage_path = syntheticUrl;
        }

        const { data: cert, error } = await this.client
            .from('certificates')
            .upsert(payload, { onConflict: 'user_id,course_id' })
            .select()
            .single();
        if (error) {
            // El trigger fn_check_certificate_ganado puede estar apuntando a la tabla
            // renombrada 'progreso_estudiante' (ahora es 'progreso_curso').
            // El backend ya validó estado='Ganado' arriba, así que este error es del trigger.
            // Solución permanente: configura DATABASE_URL en Railway para que el startup
            // migration lo corrija automáticamente, o ejecuta manualmente en Supabase:
            //   scripts/fix_trigger_certificates_progreso_curso.sql
            const triggerError = error.message?.includes('progreso_estudiante');
            if (triggerError) {
                throw new Error(
                    'El trigger de la BD está desactualizado (referencia a tabla renombrada). ' +
                    'Configura DATABASE_URL en Railway o ejecuta scripts/fix_trigger_certificates_progreso_curso.sql en Supabase.'
                );
            }
            throw new Error(error.message);
        }

        return this._mapToDomain(progressRow, cert);
    }

    async bulkIssueCertificates(pairs) {
        if (!pairs?.length) return [];

        const courseIds = [...new Set(pairs.map(p => p.courseId))];
        const userIds   = [...new Set(pairs.map(p => p.userId))];

        // ── 1. Verify 'Ganado' status and fetch progress data for URL building ──
        const { data: wonRows, error: wonError } = await this.client
            .from(SupabaseProgressRepository.COURSE_PROGRESS_TABLE)
            .select('usuario_estudiante, curso_id, promedio, calificacion_ponderada, tareas_completadas, tareas_totales, porcentaje_progreso')
            .in('curso_id', courseIds)
            .in('usuario_estudiante', userIds)
            .eq('estado', 'Ganado');

        if (wonError) throw new Error(wonError.message);

        const wonSet = new Set((wonRows || []).map(r => `${r.usuario_estudiante}-${r.curso_id}`));
        const progressByKey = new Map((wonRows || []).map(r => [`${r.usuario_estudiante}-${r.curso_id}`, r]));
        const eligiblePairs = pairs.filter(({ userId, courseId }) => wonSet.has(`${userId}-${courseId}`));

        if (!eligiblePairs.length) return [];

        // ── 2. Batch-fetch supporting data for URL generation ──
        const [existingCertsMap, usersById, coursesRaw] = await Promise.all([
            this._fetchCertificatesMap(courseIds, userIds),
            (async () => {
                const { data: users } = await this.client
                    .from('usuarios').select('id, username').in('id', userIds);
                return new Map((users || []).map(u => [u.id, u]));
            })(),
            (async () => {
                const { data: courses } = await this.client
                    .from('courses').select('id, title, creator_user_id').in('id', courseIds);
                return courses || [];
            })(),
        ]);

        const coursesById = new Map(coursesRaw.map(c => [c.id, c]));
        const creatorIds = [...new Set(coursesRaw.map(c => c.creator_user_id).filter(Boolean))];
        let creatorsById = new Map();
        if (creatorIds.length > 0) {
            const { data: creators } = await this.client
                .from('usuarios').select('id, username').in('id', creatorIds);
            creatorsById = new Map((creators || []).map(u => [u.id, u]));
        }

        // ── 3. Upsert each eligible certificate with generated URL ──
        const now = new Date().toISOString();
        const results = [];
        for (const { userId, courseId, certificateUrl, certificateIssuedAt } of eligiblePairs) {
            const key          = `${userId}-${courseId}`;
            const existingCert = existingCertsMap.get(key);
            const progressRow  = progressByKey.get(key) || {};
            const user         = usersById.get(userId)    || {};
            const course       = coursesById.get(courseId) || {};
            const creator      = creatorsById.get(course.creator_user_id) || {};

            // Preserve existing verification_code or generate a new one
            const verificationCode = existingCert?.verification_code
                || `CERT-${userId}-${courseId}-${Date.now().toString(36).toUpperCase()}`;

            const issuedAt = certificateIssuedAt || existingCert?.issued_at || now;

            // Build URL: use passed certificateUrl, then existing stored path, then generate fresh
            let storagePath = certificateUrl || existingCert?.storage_path || null;
            if (!storagePath) {
                storagePath = this._buildSyntheticCertificateUrl({
                    studentName:        user.username || null,
                    courseName:         course.title  || null,
                    grade:              progressRow.promedio ?? progressRow.calificacion_ponderada ?? null,
                    tasksCompleted:     progressRow.tareas_completadas  || 0,
                    totalTasks:         progressRow.tareas_totales      || 0,
                    progressPercentage: progressRow.porcentaje_progreso || 0,
                    instructorName:     creator.username || null,
                    instructorUsername: creator.username || null,
                    userId,
                    courseId,
                    verificationCode,
                    issuedAt,
                });
            }

            const upsertData = {
                user_id:           userId,
                course_id:         courseId,
                issued_at:         issuedAt,
                verification_code: verificationCode,
                status:            'valid',
                issued_to_name:    user.username  || null,
                course_name:       course.title   || null,
            };
            if (storagePath) upsertData.storage_path = storagePath;

            const { data, error } = await this.client
                .from('certificates')
                .upsert(
                    upsertData,
                    // ignoreDuplicates:false → allows updating storage_path on existing rows
                    { onConflict: 'user_id,course_id', ignoreDuplicates: false }
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
            .from(this._courseProgressTable())
            .select('usuario_estudiante, promedio, calificacion_ponderada')
            .in('curso_id', courseIds)
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
            .from(this._courseProgressTable())
            .select('creado_en, ultima_calculada_en')
            .in('curso_id', courseIds);
        if (progressError || !progressRows)
            return this._buildEmptyCreatorEnrollmentAnalytics(safeWeeklyDays, safeMonthlyMonths);

        return this._aggregateCreatorEnrollmentAnalytics(progressRows, safeWeeklyDays, safeMonthlyMonths);
    }

    async findWonProgressByCreatorCourses(creatorUserId) {
        const { data: creatorCourses, error: coursesError } = await this.client
            .from('courses').select('id, title, thumbnail_uri, creator_user_id').eq('creator_user_id', creatorUserId);
        if (coursesError || !creatorCourses?.length) return [];

        const courseIds = creatorCourses.map(c => c.id);
        const coursesById = new Map(creatorCourses.map(c => [c.id, c]));

        const { data: rows, error } = await this.client
            .from(this._courseProgressTable())
            .select('usuario_estudiante, curso_id, estado, promedio, calificacion_ponderada, tareas_completadas, tareas_totales, porcentaje_progreso, ultima_calculada_en, creado_en')
            .in('curso_id', courseIds)
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

        const { data: creatorUser } = await this.client
            .from('usuarios')
            .select('id, username')
            .eq('id', creatorUserId)
            .maybeSingle();

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
                certificateUrl:     this._resolveCertificateAccessUrl(cert, {
                    studentName: user.username,
                    courseName: course.title,
                    grade: row.promedio ?? row.calificacion_ponderada ?? null,
                    tasksCompleted: row.tareas_completadas || 0,
                    totalTasks: row.tareas_totales || 0,
                    progressPercentage: row.porcentaje_progreso || 0,
                    instructorName: creatorUser?.username,
                    instructorUsername: creatorUser?.username,
                    userId: row.usuario_estudiante,
                    courseId: row.curso_id,
                    verificationCode: cert?.verification_code || null,
                }),
                certificateStoredUrl: cert?.storage_path || null,
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
            .from(this._courseProgressTable())
            .select('usuario_estudiante, curso_id, estado, promedio, calificacion_ponderada, tareas_completadas, tareas_totales, porcentaje_progreso, ultima_calculada_en, creado_en')
            .eq('estado', 'Ganado');
        if (error || !rows?.length) return [];

        const courseIds = [...new Set(rows.map(r => r.curso_id).filter(Boolean))];
        const userIds   = [...new Set(rows.map(r => r.usuario_estudiante).filter(Boolean))];
        const certsMap  = await this._fetchCertificatesMap(courseIds, userIds);

        let coursesById = new Map();
        if (courseIds.length > 0) {
            const { data: courses } = await this.client
                .from('courses').select('id, title, thumbnail_uri, creator_user_id').in('id', courseIds);
            coursesById = new Map((courses || []).map(c => [c.id, c]));
        }
        let usersById = new Map();
        if (userIds.length > 0) {
            const { data: users } = await this.client
                .from('usuarios').select('id, username, avatar').in('id', userIds);
            usersById = new Map((users || []).map(u => [u.id, u]));
        }

        const creatorIds = [...new Set((Array.from(coursesById.values()) || [])
            .map(course => course?.creator_user_id)
            .filter(Boolean))];
        let creatorsById = new Map();
        if (creatorIds.length > 0) {
            const { data: creators } = await this.client
                .from('usuarios')
                .select('id, username')
                .in('id', creatorIds);
            creatorsById = new Map((creators || []).map(creator => [creator.id, creator]));
        }

        return rows.map(row => {
            const course = coursesById.get(row.curso_id) || {};
            const user   = usersById.get(row.usuario_estudiante) || {};
            const cert   = certsMap.get(`${row.usuario_estudiante}-${row.curso_id}`);
            const creator = creatorsById.get(course.creator_user_id) || {};
            return {
                userId:             row.usuario_estudiante,
                username:           user.username || null,
                avatar:             user.avatar || null,
                courseId:           row.curso_id,
                courseName:         course.title || null,
                courseThumbnail:    course.thumbnail_uri || null,
                certificateUrl:     this._resolveCertificateAccessUrl(cert, {
                    studentName: user.username,
                    courseName: course.title,
                    grade: row.promedio ?? row.calificacion_ponderada ?? null,
                    tasksCompleted: row.tareas_completadas || 0,
                    totalTasks: row.tareas_totales || 0,
                    progressPercentage: row.porcentaje_progreso || 0,
                    instructorName: creator.username,
                    instructorUsername: creator.username,
                    userId: row.usuario_estudiante,
                    courseId: row.curso_id,
                    verificationCode: cert?.verification_code || null,
                }),
                certificateStoredUrl: cert?.storage_path || null,
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

    async upsertPreEnrollment(userId, courseId, status = 'pending', reviewedBy = null) {
        const now = new Date().toISOString();
        
        // 🛡️ Defensive approach: Find existing record first
        // This works whether or not the UNIQUE constraint exists
        const existing = await this.findPreEnrollment(userId, courseId);
        
        if (existing) {
            // UPDATE existing record
            const updatePayload = { status };
            if (status === 'approved') {
                updatePayload.reviewed_at = now;
                if (reviewedBy) updatePayload.reviewed_by = reviewedBy;
            }
            
            const { data, error } = await this.client
                .from('pre_enrollments')
                .update(updatePayload)
                .eq('user_id', userId)
                .eq('course_id', courseId)
                .select()
                .single();
            
            if (error) throw new Error(error.message);
            return this._mapPreEnrollmentRecord(data);
        } else {
            // INSERT new record
            const insertPayload = {
                user_id:      userId,
                course_id:    courseId,
                status,
                requested_at: now,
            };
            if (status === 'approved') {
                insertPayload.reviewed_at = now;
                if (reviewedBy) insertPayload.reviewed_by = reviewedBy;
            }
            
            const { data, error } = await this.client
                .from('pre_enrollments')
                .insert(insertPayload)
                .select()
                .single();
            
            if (error) throw new Error(error.message);
            return this._mapPreEnrollmentRecord(data);
        }
    }

    /**
     * Returns all approved pre-enrollments for a given course, enriched with
     * basic user info (id, username, avatar).
     */
    async findApprovedPreEnrollments(courseId) {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .select('user_id, course_id, status, requested_at, reviewed_at, reviewed_by')
            .eq('course_id', courseId)
            .eq('status', 'approved')
            .order('requested_at', { ascending: false });
        if (error || !data?.length) return [];

        const userIds = [...new Set(data.map(r => Number(r.user_id)).filter(id => Number.isInteger(id) && id > 0))];
        let usersById = new Map();
        if (userIds.length > 0) {
            const { data: users } = await this.client
                .from('usuarios')
                .select('id, username, avatar')
                .in('id', userIds);
            usersById = new Map((users || []).map(u => [Number(u.id), u]));
        }

        return data.map(row => {
            const user = usersById.get(Number(row.user_id));
            return {
                userId: Number(row.user_id),
                courseId: Number(row.course_id),
                status: row.status,
                requestedAt: row.requested_at,
                reviewedAt: row.reviewed_at,
                reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
                username: user?.username || null,
                avatar: user?.avatar || null,
            };
        });
    }

    async findApprovedEnrollments() {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .select('user_id, course_id, status, requested_at, reviewed_at')
            .eq('status', 'approved')
            .order('course_id', { ascending: true });
        if (error || !data) return [];

        const userIds   = [...new Set(data.map(r => Number(r.user_id)).filter(id => Number.isInteger(id) && id > 0))];
        const courseIds = [...new Set(data.map(r => Number(r.course_id)).filter(id => Number.isInteger(id) && id > 0))];

        let usersById    = new Map();
        let personasById = new Map();
        let coursesById  = new Map();
        let subjectsByCourse = new Map();

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

            const { data: subjects } = await this.client
                .from('subjects').select('id, name, course_id').in('course_id', courseIds);
            for (const s of (subjects || [])) {
                const cid = Number(s.course_id);
                if (!subjectsByCourse.has(cid)) subjectsByCourse.set(cid, []);
                subjectsByCourse.get(cid).push({ id: s.id, name: s.name });
            }
        }

        // Fetch all active subject access blocks for the enrolled users
        // Key: "userId-courseId" → Set of blocked subjectIds
        const blockedByUserCourse = new Map();
        if (userIds.length > 0) {
            const { data: blocks } = await this.client
                .from('v_subject_access_blocks')
                .select('user_id, course_id, subject_id')
                .in('user_id', userIds)
                .eq('is_active', true);
            for (const b of (blocks || [])) {
                const key = `${Number(b.user_id)}-${Number(b.course_id)}`;
                if (!blockedByUserCourse.has(key)) blockedByUserCourse.set(key, new Set());
                blockedByUserCourse.get(key).add(Number(b.subject_id));
            }
        }

        return data.map(row => {
            const user    = usersById.get(Number(row.user_id)) || null;
            const persona = user?.persona_id ? personasById.get(Number(user.persona_id)) || null : null;
            const course  = coursesById.get(Number(row.course_id)) || null;
            const uid     = Number(row.user_id);
            const cid     = Number(row.course_id);
            const blockedSet = blockedByUserCourse.get(`${uid}-${cid}`) || new Set();
            return {
                ...this._mapPreEnrollmentRecord(row, {
                    username:       user?.username || null,
                    avatar:         user?.avatar || null,
                    fullName:       persona ? `${persona.nombres || ''} ${persona.apellidos || ''}`.trim() || null : null,
                    identificacion: persona?.identificacion ?? null,
                    courseName:     course?.title || null,
                }),
                subjects: subjectsByCourse.get(cid) || [],
                blockedSubjectIds: [...blockedSet],
            };
        });
    }

    async deleteEnrollment(userId, courseId, reason = null, revokedBy = null) {
        if (reason) {
            await this.client
                .from('pre_enrollments')
                .update({
                    status: 'revoked',
                    revoke_reason: reason,
                    reviewed_at: new Date().toISOString(),
                    ...(revokedBy ? { reviewed_by: revokedBy } : {}),
                })
                .eq('user_id', userId)
                .eq('course_id', courseId);
        } else {
            const { error } = await this.client
                .from('pre_enrollments')
                .delete()
                .eq('user_id', userId)
                .eq('course_id', courseId);
            if (error) throw new Error(error.message);
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //  SUBJECT ACCESS BLOCKS (bloqueo de acceso por materia)
    // ═══════════════════════════════════════════════════════════════

    async blockSubjectAccess(userId, courseId, subjectId, reason, blockedBy = null) {
        const now = new Date().toISOString();
        // course_id omitted: it is a transitive dependency (subject_id → subjects.course_id)
        const { data, error } = await this.client
            .from('subject_access_blocks')
            .upsert({
                user_id: userId,
                subject_id: subjectId,
                reason,
                is_active: true,
                blocked_at: now,
                updated_at: now,
                unblocked_at: null,
                unblocked_by: null,
                ...(blockedBy ? { blocked_by: blockedBy, updated_by: blockedBy } : {}),
            }, { onConflict: 'user_id,subject_id' })
            .select()
            .single();
        if (error) throw new Error(error.message);
        return data;
    }

    async unblockSubjectAccess(userId, subjectId, unblockedBy = null) {
        const now = new Date().toISOString();
        // Soft-delete: mark as inactive and record unblock audit fields
        const { error } = await this.client
            .from('subject_access_blocks')
            .update({
                is_active: false,
                unblocked_at: now,
                updated_at: now,
                ...(unblockedBy ? { unblocked_by: unblockedBy, updated_by: unblockedBy } : {}),
            })
            .eq('user_id', userId)
            .eq('subject_id', subjectId);
        if (error) throw new Error(error.message);
        return true;
    }

    async findSubjectAccessBlock(userId, subjectId) {
        const { data, error } = await this.client
            .from('subject_access_blocks')
            .select('*')
            .eq('user_id', userId)
            .eq('subject_id', subjectId)
            .eq('is_active', true)
            .maybeSingle();
        if (error || !data) return null;
        return data;
    }

    async findSubjectAccessBlocksByUserAndCourse(userId, courseId) {
        // Query the compatibility view which exposes course_id via JOIN with subjects
        const { data, error } = await this.client
            .from('v_subject_access_blocks')
            .select('*')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .eq('is_active', true);
        if (error || !data) return [];
        return data;
    }

    async findAllSubjectAccessBlocks() {
        const { data, error } = await this.client
            .from('v_subject_access_blocks')
            .select('user_id, course_id, subject_id')
            .eq('is_active', true);
        if (error || !data) return [];
        return data.map(b => ({
            userId: Number(b.user_id),
            courseId: Number(b.course_id),
            subjectId: Number(b.subject_id),
        }));
    }

    async findRevokedEnrollment(userId, courseId) {
        const { data, error } = await this.client
            .from('pre_enrollments')
            .select('*')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .eq('status', 'revoked')
            .maybeSingle();
        if (error || !data) return null;
        return this._mapPreEnrollmentRecord(data, { revokeReason: data.revoke_reason });
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
