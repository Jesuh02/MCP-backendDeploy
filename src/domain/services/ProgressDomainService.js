import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class ProgressDomainService {
    constructor({ progressRepository, taskRepository, submissionRepository }) {
        this.progressRepo = progressRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
    }

    async getByUserAndCourse(userId, courseId) {
        if (this.taskRepo && this.submissionRepo) {
            const refreshed = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
            return Result.ok(refreshed);
        }
        const progress = await this.progressRepo.findByUserAndCourse(userId, courseId);
        if (!progress) return Result.ok({ userId, courseId, completedTasks: 0, totalTasks: 0, progressPercentage: 0, averageGrade: 0, status: 'Perdido' });
        return Result.ok(progress);
    }

    async refreshForUserCourse(userId, courseId) {
        const refreshed = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
        return Result.ok(refreshed);
    }

    async getByUser(userId) {
        const progress = await this.progressRepo.findByUser(userId);
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

        if (this.taskRepo && this.submissionRepo && data ? .userId && data ? .courseId) {
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

    async getTopStudentsGlobal(limit = 10) {
        const students = await this.progressRepo.getTopStudentsGlobal(limit);
        return Result.ok(students);
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
            const userId = Number(item ? .userId);
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

    async _recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasksFromCaller = null) {
        const totalTasks = totalTasksFromCaller ? ? await this.taskRepo.countByCourse(courseId);
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