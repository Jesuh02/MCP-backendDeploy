import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class SubmissionDomainService {
    constructor({ submissionRepository, taskRepository, progressRepository }) {
        this.subRepo = submissionRepository;
        this.taskRepo = taskRepository;
        this.progressRepo = progressRepository;
    }

    async getById(id) {
        const sub = await this.subRepo.findById(id);
        if (!sub) return Result.fail(new NotFoundError('Entrega', id));
        return Result.ok(sub);
    }

    async getByTask(taskId, pagination) {
        const subs = await this.subRepo.findByTask(taskId, pagination);
        return Result.ok(subs);
    }

    async getByUser(userId, pagination) {
        const subs = await this.subRepo.findByUser(userId, pagination);
        return Result.ok(subs);
    }

    async submit(data) {
        const task = await this.taskRepo.findById(data.taskId);
        if (!task) return Result.fail(new NotFoundError('Tarea', data.taskId));

        // Check if submission already exists for this user and task
        const existingSubmission = await this.subRepo.findByUserAndTask(data.userId, data.taskId);

        if (existingSubmission) {
            // Update existing submission
            const updated = await this.subRepo.update(existingSubmission.id, {
                fileUri: data.fileUri,
                fileName: data.fileName,
                submissionDate: Date.now()
            });
            return Result.ok(updated);
        } else {
            // Create new submission
            const created = await this.subRepo.create(data);
            return Result.ok(created);
        }
    }

    async grade(id, { grade, feedback }, graderId) {
        const sub = await this.subRepo.findById(id);
        if (!sub) return Result.fail(new NotFoundError('Entrega', id));

        const updated = await this.subRepo.update(id, {
            grade,
            feedback,
            status: 'graded',
            gradedAt: new Date().toISOString(),
        });

        // Recalcular progreso del estudiante si es posible
        await this._updateProgress(sub.user_id, sub.task_id);

        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const sub = await this.subRepo.findById(id);
        if (!sub) return Result.fail(new NotFoundError('Entrega', id));
        if (sub.user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No puedes eliminar esta entrega'));
        }
        await this.subRepo.delete(id);
        return Result.ok({ message: 'Entrega eliminada' });
    }

    async _updateProgress(userId, taskId) {
        try {
            const task = await this.taskRepo.findById(taskId);
            if (!task ? .course_id) return;
            const courseId = task.course_id;

            const graded = await this.subRepo.getGradedByUserAndCourse(userId, courseId);
            const totalTasks = await this.taskRepo.countByCourse(courseId);
            const completedTasks = graded.length;
            const avgGrade = graded.length > 0 ?
                graded.reduce((s, g) => s + (g.grade || 0), 0) / graded.length :
                0;
            const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

            await this.progressRepo.upsert({
                userId,
                courseId,
                completedTasks,
                totalTasks,
                averageGrade: Math.round(avgGrade * 100) / 100,
                progressPercentage,
            });
        } catch (err) {
            console.error('Error updating progress:', err.message);
        }
    }

    async getByUserAndTask(userId, taskId) {
        const sub = await this.subRepo.findByUserAndTask(userId, taskId);
        return Result.ok(sub);
    }

    async getByCourse(courseId, pagination) {
        const subs = await this.subRepo.findByCourse(courseId, pagination);
        return Result.ok(subs);
    }
}

export default SubmissionDomainService;