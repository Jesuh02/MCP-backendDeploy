import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class ProgressDomainService {
    constructor({ progressRepository, taskRepository, submissionRepository }) {
        this.progressRepo = progressRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
    }

    async getByUserAndCourse(userId, courseId) {
        const progress = await this.progressRepo.findByUserAndCourse(userId, courseId);
        if (!progress) return Result.ok({ userId, courseId, completedTasks: 0, totalTasks: 0, progressPercentage: 0 });
        return Result.ok(progress);
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
        let progress = await this.progressRepo.upsert(data);

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

        const tasks = await this.taskRepo.findByCourse(courseId);
        const totalTasks = tasks.length;
        const taskIds = tasks.map(t => t.id);

        const enrolledStudents = await this.progressRepo.findByCourse(courseId);
        if (!enrolledStudents || enrolledStudents.length === 0) {
            return Result.ok({ recalculated: 0, totalTasks });
        }

        let recalculated = 0;
        for (const student of enrolledStudents) {
            try {
                let completedTasks = 0;
                let totalGrade = 0;
                let gradedCount = 0;

                for (const taskId of taskIds) {
                    const submission = await this.submissionRepo.findByUserAndTask(student.userId, taskId);
                    if (submission) {
                        completedTasks++;
                        if (submission.grade !== null && submission.grade !== undefined) {
                            totalGrade += submission.grade;
                            gradedCount++;
                        }
                    }
                }

                const avgGrade = gradedCount > 0 ? totalGrade / gradedCount : 0;
                const progressPct = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

                await this.progressRepo.upsert({
                    userId: student.userId,
                    courseId,
                    completedTasks,
                    totalTasks,
                    averageGrade: Math.round(avgGrade * 100) / 100,
                    progressPercentage: Math.round(progressPct * 100) / 100,
                });
                recalculated++;
            } catch (err) {
                console.error(`[ProgressService] Error recalculating for user ${student.userId}:`, err.message);
            }
        }

        return Result.ok({ recalculated, totalTasks });
    }
}
export default ProgressDomainService;