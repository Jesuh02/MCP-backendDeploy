import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class ProgressDomainService {
    constructor({ progressRepository, taskRepository, submissionRepository, courseRepository, userRepository, subjectRepository, collaboratorRepository }) {
        this.progressRepo = progressRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
        this.courseRepo = courseRepository || null;
        this.userRepo = userRepository || null;
        this.subjectRepo = subjectRepository || null;
        this.collaboratorRepo = collaboratorRepository || null;
        this._notificationService = null;
        this._courseRefreshJobs = new Map();
    }

    setNotificationService(notificationService) {
        this._notificationService = notificationService;
    }

    async getByUserAndCourse(userId, courseId) {
        const [storedProgress, gradedTasks, storedSubjectProgress] = await Promise.all([
            this.progressRepo.findByUserAndCourse(userId, courseId),
            this._buildGradedTasksWithSubject(userId, courseId),
            this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId),
        ]);

        let progress = storedProgress;
        let subjectProgress = storedSubjectProgress;

        if (!progress && this.taskRepo && this.submissionRepo) {
            progress = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
            subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);
        } else {
            progress ||= this._buildEmptyCourseProgress(userId, courseId);
            if (progress && this.taskRepo && this.submissionRepo) {
                this._scheduleUserCourseRefresh(userId, courseId);
            }
        }

        return Result.ok({ ...progress, gradedTasks, subjectProgress });
    }

    async getSubjectProgress(userId, courseId) {
        let subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);

        if ((!subjectProgress?.length) && this.taskRepo && this.submissionRepo && this.subjectRepo) {
            await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
            subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);
        } else if (subjectProgress?.length && this.taskRepo && this.submissionRepo && this.subjectRepo) {
            this._scheduleUserCourseRefresh(userId, courseId);
        }

        return Result.ok(subjectProgress || []);
    }

    async getByUserAndSubject(userId, subjectId) {
        let progress = await this.progressRepo.findByUserAndSubject(userId, subjectId);
        if (!progress && this.taskRepo && this.submissionRepo && this.subjectRepo) {
            const courseId = await this._resolveCourseFromSubjectId(subjectId);
            if (courseId) {
                await this._recalculateAndUpsertUserSubjectProgress(userId, courseId, subjectId);
                progress = await this.progressRepo.findByUserAndSubject(userId, subjectId);
            }
        }
        if (!progress) return Result.ok(this._buildEmptySubjectProgress(userId, subjectId));
        return Result.ok(progress);
    }

    async refreshForUserCourse(userId, courseId) {
        const refreshed = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
        return Result.ok(refreshed);
    }

    /**
     * Admin: devuelve el progreso por materia de TODOS los estudiantes
     * en los cursos gestionados por `requesterUserId`.
     * Admins globales (rol 3) pasan null para ver todo.
     */
    async getAllSubjectProgressForAdmin(requesterUserId = null) {
        const creatorId = requesterUserId ? Number(requesterUserId) : null;
        const items = await this.progressRepo.findAllSubjectProgressForAdmin(creatorId);
        return Result.ok(items);
    }

    async getByUser(userId, options = {}) {
        const progress = await this.progressRepo.findByUser(userId, options);
        return Result.ok(progress);
    }

    async getByCourse(courseId) {
        const progress = await this.progressRepo.findByCourse(courseId);
        return Result.ok(progress);
    }

    async getLeaderboard(courseId, limit = 10) {
        const board = await this.progressRepo.getLeaderboard(courseId, limit);
        return Result.ok(board);
    }

    async upsert(data) {
        if (data?.userId && data?.courseId && this.courseRepo) {
            const course = await this.courseRepo.findById(data.courseId);
            if (!course) {
                const resolved = await this._resolveCourseFromSubjectId(data.courseId);
                if (resolved) data.courseId = resolved;
                else return Result.fail(new NotFoundError('Curso', data.courseId));
            }
        }
        if (data?.userId && data?.courseId) {
            const blocked = await this._isCreatorOrCollaborator(data.userId, data.courseId);
            if (blocked) return Result.fail(new ForbiddenError('Creadores y colaboradores no pueden estar en el progreso de estudiantes'));
        }

        let progress = null;

        if (this.taskRepo && this.submissionRepo && data?.userId && data?.courseId) {
            progress = await this._recalculateAndUpsertUserCourseProgress(data.userId, data.courseId, null, data.subjectId);
        } else {
            progress = await this.progressRepo.upsert(data);
        }

        if (this._isProgressWon(progress) && !progress.certificateIssuedAt) {
            progress = await this.progressRepo.updateCertificate(data.userId, data.courseId, {
                certificateIssuedAt: new Date().toISOString(),
            });
        }

        return Result.ok(progress);
    }

    async getEnrolledCount(courseId) {
        const count = await this.progressRepo.countByCourse(courseId);
        return Result.ok({ count });
    }

    async isEnrolled(userId, courseId) {
        const enrolled = await this.progressRepo.isEnrolled(userId, courseId);
        return Result.ok({ isEnrolled: enrolled });
    }

    async getEnrolledCourseIds(userId) {
        const ids = await this.progressRepo.findEnrolledCourseIds(userId);
        return Result.ok(ids);
    }

    async getTopStudentsByCreator(creatorUserId, limit = 5) {
        const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 5;
        const creatorId = Number(creatorUserId);
        if (!Number.isInteger(creatorId) || creatorId <= 0) {
            console.warn('[ProgressService] getTopStudentsByCreator: creatorUserId inválido', creatorUserId);
            return Result.ok([]);
        }

        // ── 1. Obtener IDs de cursos del creador (via CourseRepository) ──
        let courseIds = [];
        if (this.courseRepo && typeof this.courseRepo.findCourseIdsByCreatorUserId === 'function') {
            courseIds = await this.courseRepo.findCourseIdsByCreatorUserId(creatorId);
        } else if (this.courseRepo && typeof this.courseRepo.findByCreatorUserId === 'function') {
            const courses = await this.courseRepo.findByCreatorUserId(creatorId);
            courseIds = (courses || []).map(c => c.id);
        } else {
            console.error('[ProgressService] courseRepo no disponible; no se puede resolver top students por creador');
            return Result.ok([]);
        }

        if (courseIds.length === 0) {
            console.info(`[ProgressService] Creador ${creatorId} no tiene cursos registrados`);
            return Result.ok([]);
        }

        console.info(`[ProgressService] Creador ${creatorId} → ${courseIds.length} cursos: [${courseIds.join(', ')}]`);

        // ── 2. Obtener progreso 'Ganado' en esos cursos (via ProgressRepository) ──
        const wonProgress = await this.progressRepo.findWonProgressByCourseIds(courseIds);

        if (!wonProgress || wonProgress.length === 0) {
            console.info(`[ProgressService] Sin progreso 'Ganado' en cursos del creador ${creatorId}`);
            return Result.ok([]);
        }

        // ── 3. Agregar métricas por estudiante (excluir al propio creador) ──
        const aggregated = new Map();
        for (const row of wonProgress) {
            if (!Number.isInteger(row.userId) || row.userId <= 0) continue;
            if (row.userId === creatorId) continue; // No incluir al creador como su propio estudiante destacado

            const existing = aggregated.get(row.userId) || {
                user_id: row.userId,
                approved_courses: 0,
                total_grade: 0,
                graded_courses: 0,
                average_grade: 0,
                username: null,
                avatar: null,
            };

            existing.approved_courses += 1;
            if (Number.isFinite(row.grade)) {
                existing.total_grade += Number(row.grade) || 0;
                existing.graded_courses += 1;
            }
            aggregated.set(row.userId, existing);
        }

        // Calcular promedio
        for (const student of aggregated.values()) {
            if (student.graded_courses > 0) {
                student.average_grade = Number((student.total_grade / student.graded_courses).toFixed(2));
            }
        }

        // Ranking: mayor promedio → más cursos aprobados → menor ID
        const ranked = [...aggregated.values()]
            .filter(s => s.approved_courses > 0)
            .sort((a, b) => {
                if (b.average_grade !== a.average_grade) return b.average_grade - a.average_grade;
                if (b.approved_courses !== a.approved_courses) return b.approved_courses - a.approved_courses;
                return a.user_id - b.user_id;
            })
            .slice(0, safeLimit);

        // ── 4. Enriquecer con perfil de usuario (via UserRepository) ──
        const studentIds = ranked.map(s => s.user_id);
        if (studentIds.length > 0 && this.userRepo && typeof this.userRepo.findByIds === 'function') {
            const usersData = await this.userRepo.findByIds(studentIds);
            const usersById = new Map((usersData || []).map(u => [Number(u.id), u]));

            for (const student of ranked) {
                const user = usersById.get(student.user_id);
                if (!user) continue;
                if (user.username) student.username = user.username;
                if (user.avatar) student.avatar = user.avatar;
            }
        }

        const result = ranked.map(s => ({
            user_id: s.user_id,
            username: s.username || `Usuario ${s.user_id}`,
            avatar: s.avatar || null,
            approved_courses: s.approved_courses,
            average_grade: s.average_grade,
        }));

        console.info(`[ProgressService] Top students para creador ${creatorId}: ${result.length} encontrados`);
        return Result.ok(result);
    }

    async getTopStudentsGlobal(limit = 5, creatorUserId = null) {
        return this.getTopStudentsByCreator(creatorUserId, limit);
    }

    async getCreatorEnrollmentAnalytics(creatorUserId, options = {}) {
        const analytics = await this.progressRepo.getCreatorEnrollmentAnalytics(creatorUserId, options);
        return Result.ok(analytics);
    }

    async issueCertificate(userId, courseId) {
        try {
            const updated = await this.progressRepo.updateCertificate(userId, courseId, {
                certificateIssuedAt: new Date().toISOString(),
            });
            return Result.ok(updated);
        } catch (error) {
            const message = String(error?.message || error || '');
            if (message.includes('no tiene progreso registrado')) {
                return Result.fail(new NotFoundError('Progreso', `${userId}-${courseId}`));
            }
            if (message.includes('no ha ganado el curso') || message.includes('estado actual')) {
                return Result.fail(new ForbiddenError('Solo se pueden emitir certificados para progreso con estado Ganado'));
            }
            // Any other DB / constraint error — wrap instead of rethrowing to avoid 500
            return Result.fail(new ForbiddenError(`No se pudo emitir el certificado: ${message}`));
        }
    }

    async getMyCertificates(userId) {
        const certificates = await this.progressRepo.findCertificatesByUser(userId);
        if (!certificates?.length || !this.courseRepo) return Result.ok(certificates);

        // Only certificates with status 'Ganado' and not creator/collaborator
        const wonCerts = certificates.filter(cert => this._isProgressWon(cert));
        const blockedChecks = await Promise.all(
            wonCerts.map(cert => this._isCreatorOrCollaborator(userId, cert.courseId))
        );
        const filtered = wonCerts.filter((_, i) => !blockedChecks[i]);
        return Result.ok(filtered);
    }

    async getCreatorCertificates(creatorUserId) {
        const rows = await this.progressRepo.findWonProgressByCreatorCourses(creatorUserId);
        const filtered = (rows || []).filter(r => this._isProgressWon(r));
        return Result.ok(filtered);
    }

    async bulkIssueCertificatesForCreator(creatorUserId) {
        const rows = await this.progressRepo.findWonProgressByCreatorCourses(creatorUserId);
        const pending = rows.filter(r => this._isProgressWon(r) && !r.certificateIssuedAt);
        if (pending.length === 0) return Result.ok({ issued: 0 });
        const pairs = pending.map(r => ({ userId: r.userId, courseId: r.courseId }));
        const issued = await this.progressRepo.bulkIssueCertificates(pairs);
        return Result.ok({ issued: issued.length });
    }

    async getAllWonCertificates() {
        const rows = await this.progressRepo.findAllWonProgress();
        const filtered = (rows || []).filter(r => this._isProgressWon(r));
        return Result.ok(filtered);
    }

    async bulkIssueCertificatesGlobal() {
        const rows = await this.progressRepo.findAllWonProgress();
        const pending = rows.filter(r => this._isProgressWon(r) && !r.certificateIssuedAt);
        if (pending.length === 0) return Result.ok({ issued: 0 });
        const pairs = pending.map(r => ({ userId: r.userId, courseId: r.courseId }));
        const issued = await this.progressRepo.bulkIssueCertificates(pairs);
        return Result.ok({ issued: issued.length });
    }

    async updateCertificateUrl(userId, courseId, url) {
        // url puede ser una URL completa o un path relativo de Storage.
        // El repositorio almacena storage_path; la URL pública se construye en el cliente.
        const updated = await this.progressRepo.updateCertificate(userId, courseId, {
            certificateUrl: url,
        });
        return Result.ok(updated);
    }

    async getAllByCourse(courseId) {
        const progress = await this.progressRepo.findByCourse(courseId);
        // Enrich with usernames and avatars from user repository
        if (progress?.length && this.userRepo && typeof this.userRepo.findByIds === 'function') {
            const userIds = [...new Set(progress.map(p => p.userId).filter(id => id))];
            if (userIds.length > 0) {
                try {
                    const users = await this.userRepo.findByIds(userIds);
                    const usersById = new Map((users || []).map(u => [Number(u.id), u]));
                    for (const p of progress) {
                        const user = usersById.get(Number(p.userId));
                        if (user) {
                            p.username = user.username || null;
                            p.avatar = user.avatar || null;
                        }
                    }
                } catch (err) {
                    console.warn('[ProgressService] Error enriching getAllByCourse with usernames:', err.message);
                }
            }
        }
        return Result.ok(progress);
    }

    /**
     * Recalculate progress for all enrolled students in a course.
     * Fetches total tasks, completed submissions, and average grades,
     * then upserts each student's progress record.
     */
    async recalculateForCourse(courseId) {
        if (!this.taskRepo || !this.submissionRepo) {
            return Result.fail(new Error('Task/Submission repositories not available'));
        }

        const totalTasks = await this.taskRepo.countByCourse(courseId);

        const candidateUserIds = await this._resolveCandidateUserIdsForCourse(courseId);
        if (!candidateUserIds || candidateUserIds.length === 0) {
            return Result.ok({ recalculated: 0, totalTasks });
        }

        // Parallelize in batches of 5 to avoid overwhelming the DB
        const BATCH_SIZE = 5;
        let recalculated = 0;
        for (let i = 0; i < candidateUserIds.length; i += BATCH_SIZE) {
            const batch = candidateUserIds.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(userId => this._recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasks))
            );
            for (const r of results) {
                if (r.status === 'fulfilled') recalculated++;
                else console.error(`[ProgressService] Error recalculating:`, r.reason?.message);
            }
        }

        return Result.ok({ recalculated, totalTasks });
    }

    async _resolveCandidateUserIdsForCourse(courseId) {
        const ids = new Set();

        const existingProgress = await this.progressRepo.findByCourse(courseId);
        for (const item of existingProgress || []) {
            const userId = Number(item?.userId);
            if (Number.isInteger(userId) && userId > 0) ids.add(userId);
        }

        if (typeof this.submissionRepo.getStudentIdsByCourse === 'function') {
            const fromSubmissions = await this.submissionRepo.getStudentIdsByCourse(courseId);
            for (const userId of fromSubmissions || []) {
                const parsed = Number(userId);
                if (Number.isInteger(parsed) && parsed > 0) ids.add(parsed);
            }
        }

        return [...ids];
    }

    async _buildGradedTasksWithSubject(userId, courseId) {
        if (!this.submissionRepo) return [];
        const graded = await this.submissionRepo.getGradedByUserAndCourse(userId, courseId);
        let subjectsById = new Map();
        if (this.subjectRepo && typeof this.subjectRepo.findByCourse === 'function') {
            const subjects = await this.subjectRepo.findByCourse(courseId, { activeOnly: false });
            subjectsById = new Map(subjects.map(s => [s.id, s]));
        }
        return graded.map(sub => {
            const subjectId = sub.tasks?.topics?.materia_id || sub.tasks?.topics?.subject_id || null;
            const subject = subjectId ? subjectsById.get(subjectId) : null;
            return {
                taskId: sub.task_id,
                taskTitle: sub.tasks?.title || null,
                topicId: sub.tasks?.topic_id || null,
                topicName: sub.tasks?.topics?.name || null,
                subjectId,
                subjectName: subject?.name || null,
                grade: sub.grade,
            };
        });
    }

    _buildEmptyCourseProgress(userId, courseId, overrides = {}) {
        return {
            userId,
            courseId,
            completedTasks: 0,
            totalTasks: 0,
            progressPercentage: 0,
            averageGrade: 0,
            status: 'Perdido',
            ...overrides,
        };
    }

    _buildEmptySubjectProgress(userId, subjectId, overrides = {}) {
        return {
            userId,
            subjectId,
            completedTasks: 0,
            totalTasks: 0,
            progressPercentage: 0,
            averageGrade: 0,
            status: 'Perdido',
            ...overrides,
        };
    }

    _scheduleUserCourseRefresh(userId, courseId) {
        if (!this.taskRepo || !this.submissionRepo) return;

        const refreshKey = `${userId}:${courseId}`;
        if (this._courseRefreshJobs.has(refreshKey)) return;

        const refreshJob = (async () => {
            try {
                await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
            } catch (err) {
                console.error(`[ProgressService] Error refreshing progress for user ${userId} in course ${courseId}:`, err?.message || err);
            } finally {
                this._courseRefreshJobs.delete(refreshKey);
            }
        })();

        this._courseRefreshJobs.set(refreshKey, refreshJob);
    }

    async _recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasksFromCaller = null, subjectIdFallback = null) {
        // Skip recalculation for creators/collaborators — they are not students
        const blocked = await this._isCreatorOrCollaborator(userId, courseId);
        if (blocked) return { userId, courseId, completedTasks: 0, totalTasks: 0, averageGrade: 0, progressPercentage: 0, status: 'Excluido' };

        // Fetch totalTasks, submittedTaskIds and graded in parallel
        const [totalTasks, submittedTaskIds, graded] = await Promise.all([
            totalTasksFromCaller != null ? totalTasksFromCaller : this.taskRepo.countByCourse(courseId),
            this.submissionRepo.getTaskIdsByUserAndCourse(userId, courseId),
            this.submissionRepo.getGradedByUserAndCourse(userId, courseId),
        ]);
        const completedTasks = submittedTaskIds.length;

        const gradedSum = graded.reduce((sum, item) => sum + (Number(item.grade) || 0), 0);
        const averageGradeRaw = totalTasks > 0 ? (gradedSum / totalTasks) : 0;
        const averageGrade = Math.round(averageGradeRaw * 100) / 100;

        const progressPercentageRaw = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
        const progressPercentage = Math.round(progressPercentageRaw * 100) / 100;

        const status = averageGrade >= 6 ? 'Ganado' : 'Perdido';

        const persisted = await this.progressRepo.upsert({
            userId,
            courseId,
            completedTasks,
            totalTasks,
            averageGrade,
            progressPercentage,
            subjectId: 0,
            status,
        });

        await this._recalculateSubjectsForUserCourse(userId, courseId);

        return persisted || {
            userId,
            courseId,
            completedTasks,
            totalTasks,
            averageGrade,
            progressPercentage,
            status,
        };
    }

    async _recalculateSubjectsForUserCourse(userId, courseId) {
        if (!this.subjectRepo || !this.taskRepo || !this.submissionRepo) return;
        const subjects = await this.subjectRepo.findByCourse(courseId, { activeOnly: false });
        if (!subjects?.length) return;

        const results = await Promise.allSettled(
            subjects.map(subject => this._recalculateAndUpsertUserSubjectProgress(userId, courseId, subject.id))
        );
        for (const r of results) {
            if (r.status === 'rejected') {
                console.error(`[ProgressService] Error recalculating subject for user ${userId}:`, r.reason?.message);
            }
        }
    }

    async _recalculateAndUpsertUserSubjectProgress(userId, courseId, subjectId) {
        const totalTasks = await this.taskRepo.countBySubject(subjectId);
        if (totalTasks === 0) return null;

        const submittedTaskIds = await this.submissionRepo.getTaskIdsByUserAndSubject(userId, subjectId);
        const completedTasks = submittedTaskIds.length;

        const graded = await this.submissionRepo.getGradedByUserAndSubject(userId, subjectId);
        const gradedSum = graded.reduce((sum, item) => sum + (Number(item.grade) || 0), 0);
        const averageGradeRaw = totalTasks > 0 ? (gradedSum / totalTasks) : 0;
        const averageGrade = Math.round(averageGradeRaw * 100) / 100;

        const progressPercentageRaw = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
        const progressPercentage = Math.round(progressPercentageRaw * 100) / 100;

        const status = averageGrade >= 6 ? 'Ganado' : 'Perdido';

        return this.progressRepo.upsert({
            userId,
            courseId,
            completedTasks,
            totalTasks,
            averageGrade,
            progressPercentage,
            subjectId,
            status,
        });
    }

    async _resolveCourseFromSubjectId(subjectId) {
        if (!this.subjectRepo) return null;
        const subject = await this.subjectRepo.findById(subjectId);
        return subject?.course_id || null;
    }

    async _isCreatorOrCollaborator(userId, courseId) {
        if (!this.courseRepo) return false;
        const course = await this.courseRepo.findById(courseId);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(userId)) return true;
        if (!this.collaboratorRepo) return false;
        return this.collaboratorRepo.isCollaborator(Number(userId), courseId);
    }

    _isProgressWon(progress) {
        return String(progress?.status || '').trim().toLowerCase() === 'ganado';
    }

    _normalizeRoleIds(roles = []) {
        return [...new Set((roles || [])
            .map((role) => Number(role?.id ?? role))
            .filter((roleId) => Number.isInteger(roleId) && roleId > 0))];
    }

    async _getUserRoleIds(userId) {
        if (!userId || !this.userRepo || typeof this.userRepo.getUserRoles !== 'function') return [];
        try {
            const roles = await this.userRepo.getUserRoles(userId);
            return this._normalizeRoleIds(roles);
        } catch {
            return [];
        }
    }

    _isCourseAvailableForEnrollment(course) {
        const storedActive = course?.isActive ?? course?.is_active;
        const isActive = typeof storedActive === 'undefined'
            ? true
            : ['false', '0', 'no'].includes(String(storedActive).trim().toLowerCase())
                ? false
                : Boolean(storedActive);
        if (!isActive) return false;
        if (!course?.deadline) return true;
        const deadline = new Date(course.deadline);
        return Number.isNaN(deadline.getTime()) || deadline > new Date();
    }

    // ─── Enrollment request flow (Pre-enrollment / Matrícula) ─────────────

    /**
     * Student requests enrollment in a course. Creates a pre_enrollment record
     * with status = 'pending'. Does NOT allow duplicate requests.
     */
    async requestEnrollment(userId, courseId) {
        if (!this.courseRepo) return Result.fail(new Error('CourseRepository not available'));

        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));

        const roleIds = await this._getUserRoleIds(userId);
        if (roleIds.includes(3)) {
            return Result.fail(new ForbiddenError('Los administradores no pueden matricularse en cursos'));
        }
        if (!roleIds.some((roleId) => roleId === 1 || roleId === 2)) {
            return Result.fail(new ForbiddenError('Solo los usuarios con rol 1 o rol 2 pueden solicitar matricula'));
        }

        if (!this._isCourseAvailableForEnrollment(course)) {
            if (course.deadline && new Date(course.deadline) <= new Date() && typeof this.courseRepo.updateActiveState === 'function') {
                await this.courseRepo.updateActiveState(courseId, false).catch(() => {});
            }
            return Result.fail(new ForbiddenError('El curso esta inactivo o expirado y no acepta nuevas matriculaciones'));
        }

        // Prevent creators/collaborators from enrolling
        const blocked = await this._isCreatorOrCollaborator(userId, courseId);
        if (blocked) return Result.fail(new ForbiddenError('Creadores y colaboradores no pueden matricularse'));

        // Check existing pre-enrollment
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (existing) {
            const existingStatus = this._getEnrollmentStatusValue(existing);
            if (existingStatus === 'approved') {
                return Result.ok({ ...existing, message: 'Ya estás matriculado' });
            }
            if (existingStatus === 'pending') {
                return Result.ok({ ...existing, message: 'Tu solicitud ya está pendiente de aprobación' });
            }
            // rejected — allow re-request
        }

        const pending = await this.progressRepo.upsertPreEnrollment(userId, courseId, 'pending');

        // Notify all role 3 (admin) users about the new enrollment request
        this._notifyAdminsAboutEnrollmentRequest(userId, courseId, course.title).catch(err =>
            console.warn('[ProgressService] Error notifying admins about enrollment request:', err?.message)
        );

        return Result.ok({ ...pending, message: 'Solicitud de matrícula enviada' });
    }

    /**
     * Admin approves an enrollment request.
     */
    async approveEnrollment(userId, courseId) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('Solicitud de matrícula', `${userId}/${courseId}`));

        const updated = await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'approved');

        // Notify the student about enrollment approval
        if (this._notificationService) {
            try {
                let courseName = 'un curso';
                if (this.courseRepo) {
                    const course = await this.courseRepo.findById(courseId);
                    if (course?.title) courseName = course.title;
                }
                await this._notificationService.send(userId, {
                    title: '¡Matrícula aprobada!',
                    message: `Tu solicitud de matrícula en "${courseName}" ha sido aprobada. ¡Ya puedes comenzar!`,
                    type: 'enrollment_approved',
                    relatedId: courseId,
                    metadata: { courseId, courseName },
                });

                // Send confirmation email to the student
                try {
                    let studentName = 'Estudiante';
                    if (this.userRepo) {
                        const student = await this.userRepo.findById(userId);
                        if (student?.username) studentName = student.username;
                    }
                    const { generateEnrollmentApprovedEmailHTML } = await import('../../templates/emailTemplates.js');
                    const html = generateEnrollmentApprovedEmailHTML(studentName, courseName);
                    await this._notificationService.sendEmail(userId, {
                        subject: `✅ ¡Tu matrícula en "${courseName}" ha sido aprobada!`,
                        html,
                        text: `¡Felicitaciones ${studentName}! Tu solicitud de matrícula en el curso "${courseName}" ha sido aprobada. Ya puedes acceder al contenido del curso en CourseV.`,
                    });
                } catch (emailErr) {
                    console.warn('[ProgressService] Error sending enrollment approved email:', emailErr?.message);
                }
            } catch (err) {
                console.error('[ProgressService] Error sending enrollment notification:', err?.message);
            }
        }

        return Result.ok({ ...updated, message: 'Matrícula aprobada' });
    }

    /**
     * Admin rejects an enrollment request.
     */
    async rejectEnrollment(userId, courseId) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('Solicitud de matrícula', `${userId}/${courseId}`));

        const updated = await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'rejected');
        return Result.ok({ ...updated, message: 'Matrícula rechazada' });
    }

    /**
     * Admin: get all pending enrollment requests (optionally for a specific course).
     */
    async getPendingEnrollments(courseId = null) {
        const rows = await this.progressRepo.findPendingEnrollments(courseId);
        return Result.ok(rows || []);
    }

    /**
     * Admin: get all approved enrollments (users with active access) grouped by course.
     */
    async getApprovedEnrollments() {
        const rows = await this.progressRepo.findApprovedEnrollments();
        return Result.ok(rows || []);
    }

    /**
     * Admin: revoke a user's enrollment (remove course access).
     */
    async revokeEnrollment(userId, courseId, reason = null) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('Matrícula', `${userId}/${courseId}`));
        await this.progressRepo.deleteEnrollment(userId, courseId, reason);

        // Notify the student about revocation
        if (this._notificationService && reason) {
            try {
                let courseName = 'un curso';
                if (this.courseRepo) {
                    const course = await this.courseRepo.findById(courseId);
                    if (course?.title) courseName = course.title;
                }
                await this._notificationService.send(userId, {
                    title: 'Se te quitó el acceso',
                    message: `Tu acceso a "${courseName}" fue revocado. Motivo: ${reason}`,
                    type: 'enrollment_revoked',
                    relatedId: courseId,
                    metadata: { courseId, courseName, reason },
                });
            } catch (err) {
                console.error('[ProgressService] Error sending revoke notification:', err?.message);
            }
        }

        return Result.ok({ message: 'Acceso al curso revocado', reason });
    }

    // ─── Subject Access Blocks ────────────────────────────────────

    /**
     * Admin: block a user from accessing a specific subject.
     */
    async blockSubjectAccess(userId, courseId, subjectId, reason, blockedBy = null) {
        if (!reason || !String(reason).trim()) {
            return Result.fail(new ForbiddenError('Debe proporcionar una razón para bloquear el acceso'));
        }
        const block = await this.progressRepo.blockSubjectAccess(userId, courseId, subjectId, reason.trim(), blockedBy);

        // Notify the student
        if (this._notificationService) {
            try {
                let subjectName = 'una materia';
                if (this.subjectRepo) {
                    const subject = await this.subjectRepo.findById(subjectId);
                    if (subject?.name) subjectName = subject.name;
                }
                await this._notificationService.send(userId, {
                    title: 'Se te quitó el permiso',
                    message: `Tu acceso a la materia "${subjectName}" fue revocado. Motivo: ${reason}`,
                    type: 'subject_access_blocked',
                    relatedId: subjectId,
                    metadata: { subjectId, subjectName, reason, courseId },
                });
            } catch (err) {
                console.error('[ProgressService] Error sending subject block notification:', err?.message);
            }
        }

        return Result.ok(block);
    }

    /**
     * Admin: unblock a user's access to a specific subject.
     */
    async unblockSubjectAccess(userId, subjectId) {
        await this.progressRepo.unblockSubjectAccess(userId, subjectId);
        return Result.ok({ message: 'Acceso a la materia restaurado' });
    }

    /**
     * Check if a user is blocked from a specific subject.
     */
    async checkSubjectAccessBlock(userId, subjectId) {
        const block = await this.progressRepo.findSubjectAccessBlock(userId, subjectId);
        return Result.ok({
            blocked: !!block,
            reason: block?.reason || null,
            blockedAt: block?.blocked_at || null,
        });
    }

    /**
     * Get all subject access blocks for a user in a course.
     */
    async getSubjectAccessBlocks(userId, courseId) {
        const blocks = await this.progressRepo.findSubjectAccessBlocksByUserAndCourse(userId, courseId);
        return Result.ok(blocks || []);
    }

    /**
     * Check if student has an approved enrollment in a course.
     */
    async isEnrolledAndApproved(userId, courseId) {
        const row = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!row) return Result.ok({ enrolled: false, status: null, enrollmentStatus: null });
        const status = this._getEnrollmentStatusValue(row);
        return Result.ok({
            enrolled: status === 'approved',
            status,
            enrollmentStatus: status,
        });
    }

    _getEnrollmentStatusValue(record) {
        const status = record?.enrollmentStatus ?? record?.enrollment_status ?? record?.status ?? null;
        return typeof status === 'string' ? status.trim().toLowerCase() : null;
    }

    async _notifyAdminsAboutEnrollmentRequest(studentUserId, courseId, courseTitle) {
        if (!this._notificationService || !this.userRepo) return;

        // Get all admin user IDs (role 3)
        let adminUserIds = [];
        if (typeof this.userRepo.findUserIdsByRoleId === 'function') {
            adminUserIds = await this.userRepo.findUserIdsByRoleId(3);
        }
        if (!adminUserIds || adminUserIds.length === 0) return;

        // Get student info
        let studentName = 'Un estudiante';
        let studentAvatar = null;
        try {
            const student = await this.userRepo.findById(studentUserId);
            if (student) {
                studentName = student.username || studentName;
                studentAvatar = student.avatar || null;
            }
        } catch { /* ignore */ }

        const courseName = courseTitle || 'un curso';

        // Send push/in-app notification to all admins
        await this._notificationService.sendBulk(adminUserIds, {
            title: 'Nueva solicitud de matrícula',
            message: `${studentName} ha solicitado matricularse en "${courseName}".`,
            type: 'enrollment_request',
            relatedId: courseId,
            senderUsername: studentName,
            senderAvatarUrl: studentAvatar,
            metadata: { courseId, courseName, studentUserId },
            actorUserId: studentUserId,
        });

        // Send email to each admin
        try {
            const { generateEnrollmentRequestEmailHTML } = await import('../../templates/emailTemplates.js');
            for (const adminId of adminUserIds) {
                if (Number(adminId) === Number(studentUserId)) continue;
                try {
                    let adminName = 'Administrador';
                    const admin = await this.userRepo.findById(adminId);
                    if (admin) adminName = admin.username || adminName;

                    const html = generateEnrollmentRequestEmailHTML(adminName, studentName, courseName, studentAvatar);
                    await this._notificationService.sendEmail(adminId, {
                        subject: `📋 Nueva solicitud de matrícula: ${studentName} → "${courseName}"`,
                        html,
                        text: `${studentName} ha solicitado matricularse en el curso "${courseName}". Revisa la solicitud en el panel de administración.`,
                    });
                } catch (emailErr) {
                    console.warn(`[ProgressService] Error sending enrollment email to admin ${adminId}:`, emailErr?.message);
                }
            }
        } catch (err) {
            console.warn('[ProgressService] Error loading email template:', err?.message);
        }
    }
}
export default ProgressDomainService;