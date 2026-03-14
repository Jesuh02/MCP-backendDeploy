import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class ProgressDomainService {
    constructor({ progressRepository, taskRepository, submissionRepository, courseRepository, userRepository, subjectRepository }) {
        this.progressRepo = progressRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
        this.courseRepo = courseRepository || null;
        this.userRepo = userRepository || null;
        this.subjectRepo = subjectRepository || null;
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
        return Result.ok({ ...progress, gradedTasks });
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
        let progress = null;

        if (this.taskRepo && this.submissionRepo && data?.userId && data?.courseId) {
            progress = await this._recalculateAndUpsertUserCourseProgress(data.userId, data.courseId);
        } else {
            progress = await this.progressRepo.upsert(data);
        }

        // Auto-issue certificate if passed (status 'Ganado' or grade >= 6) and not yet issued
        // 'Ganado' logic is consistent with DB generated column
        if ((progress.status === 'Ganado' || progress.averageGrade >= 6) && !progress.certificateIssuedAt) {
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
                existing.total_grade += row.grade;
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
        const updated = await this.progressRepo.updateCertificate(userId, courseId, {
            certificateIssuedAt: new Date().toISOString(),
        });
        return Result.ok(updated);
    }

    async getMyCertificates(userId) {
        const certificates = await this.progressRepo.findCertificatesByUser(userId);
        return Result.ok(certificates);
    }

    async updateCertificateUrl(userId, courseId, url) {
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
        let subjects = [];
        if (this.subjectRepo && typeof this.subjectRepo.findByCourse === 'function') {
            subjects = await this.subjectRepo.findByCourse(courseId);
        }
        const subjectsMap = subjects.map(s => ({ id: s.id, name: s.name }));
        return graded.map(sub => ({
            taskId: sub.task_id,
            taskTitle: sub.tasks?.title || null,
            topicId: sub.tasks?.topic_id || null,
            topicName: sub.tasks?.topics?.name || null,
            grade: sub.grade,
            subjects: subjectsMap,
        }));
    }

    async _recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasksFromCaller = null) {
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
            status,
        });

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
}
export default ProgressDomainService;