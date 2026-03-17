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
    }

    async getByUserAndCourse(userId, courseId) {
        let progress;
        if (this.taskRepo && this.submissionRepo) {
            progress = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
        } else {
            progress = await this.progressRepo.findByUserAndCourse(userId, courseId);
            if (!progress) progress = { userId, courseId, completedTasks: 0, totalTasks: 0, progressPercentage: 0, averageGrade: 0, status: 'Perdido' };
        }
        const gradedTasks = await this._buildGradedTasksWithSubject(userId, courseId);
        const subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);
        return Result.ok({ ...progress, gradedTasks, subjectProgress });
    }

    async getSubjectProgress(userId, courseId) {
        if (this.taskRepo && this.submissionRepo && this.subjectRepo) {
            await this._recalculateSubjectsForUserCourse(userId, courseId);
        }
        const subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);
        return Result.ok(subjectProgress);
    }

    async getByUserAndSubject(userId, subjectId) {
        const progress = await this.progressRepo.findByUserAndSubject(userId, subjectId);
        if (!progress) return Result.ok({ userId, subjectId, completedTasks: 0, totalTasks: 0, progressPercentage: 0, averageGrade: 0, status: 'Perdido' });
        return Result.ok(progress);
    }

    async refreshForUserCourse(userId, courseId) {
        const refreshed = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
        return Result.ok(refreshed);
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
        const progress = await this.progressRepo.findByUserAndCourse(userId, courseId);
        if (!progress) return Result.fail(new NotFoundError('Progreso', `${userId}-${courseId}`));
        if (!this._isProgressWon(progress)) {
            return Result.fail(new ForbiddenError('Solo se pueden emitir certificados para progreso con estado Ganado'));
        }
        const updated = await this.progressRepo.updateCertificate(userId, courseId, {
            certificateIssuedAt: new Date().toISOString(),
        });
        return Result.ok(updated);
    }

    async getMyCertificates(userId) {
        const certificates = await this.progressRepo.findCertificatesByUser(userId);
        return Result.ok(certificates);
    }

    async getCreatorCertificates(creatorUserId) {
        const rows = await this.progressRepo.findWonProgressByCreatorCourses(creatorUserId);
        return Result.ok(rows);
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
        return Result.ok(rows);
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

        let recalculated = 0;
        for (const userId of candidateUserIds) {
            try {
                await this._recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasks);
                recalculated++;
            } catch (err) {
                console.error(`[ProgressService] Error recalculating for user ${userId}:`, err.message);
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

    async _recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasksFromCaller = null, subjectIdFallback = null) {
        const totalTasks = totalTasksFromCaller ?? await this.taskRepo.countByCourse(courseId);
        const submittedTaskIds = await this.submissionRepo.getTaskIdsByUserAndCourse(userId, courseId);
        const completedTasks = submittedTaskIds.length;

        const graded = await this.submissionRepo.getGradedByUserAndCourse(userId, courseId);
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

        for (const subject of subjects) {
            try {
                await this._recalculateAndUpsertUserSubjectProgress(userId, courseId, subject.id);
            } catch (err) {
                console.error(`[ProgressService] Error recalculating subject ${subject.id} for user ${userId}:`, err.message);
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
        return Result.ok({ ...pending, message: 'Solicitud de matrícula enviada' });
    }

    /**
     * Admin approves an enrollment request.
     */
    async approveEnrollment(userId, courseId) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('Solicitud de matrícula', `${userId}/${courseId}`));

        const updated = await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'approved');
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
}
export default ProgressDomainService;