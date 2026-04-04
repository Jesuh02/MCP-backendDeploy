/**
 * EnrollStudentUseCase — Caso de uso: Inscribir estudiante a un curso.
 *
 * SRP: Solo orquesta la inscripción.
 * Emite StudentEnrolledEvent para notificaciones (desacoplado).
 */
import { Result } from '../../../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../../../shared/errors/index.js';
import { eventBus, StudentEnrolledEvent } from '../../../../shared/events/EventBus.js';

export class EnrollStudentUseCase {
    constructor({ courseRepository, progressRepository }) {
        this.courseRepo = courseRepository;
        this.progressRepo = progressRepository;
    }

    /**
     * @param {object} input
     * @param {number} input.userId — ID del estudiante.
     * @param {number} input.courseId — ID del curso.
     * @returns {Promise<Result>}
     */
    async execute({ userId, courseId }) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) {
            return Result.fail(new NotFoundError('Curso', courseId));
        }

        if (!course.isActive && !course.is_active) {
            return Result.fail(new ForbiddenError('El curso está inactivo'));
        }

        // Check if already enrolled
        if (this.progressRepo && typeof this.progressRepo.findByUserAndCourse === 'function') {
            const existing = await this.progressRepo.findByUserAndCourse(userId, courseId);
            if (existing) {
                return Result.ok({ alreadyEnrolled: true, enrollment: existing });
            }
        }

        // Create enrollment (progress entry)
        let enrollment = null;
        if (this.progressRepo && typeof this.progressRepo.createEnrollment === 'function') {
            enrollment = await this.progressRepo.createEnrollment(userId, courseId);
        }

        // Emit domain event
        eventBus.publish(new StudentEnrolledEvent({ userId, courseId }));

        return Result.ok({ enrolled: true, enrollment });
    }
}

export default EnrollStudentUseCase;