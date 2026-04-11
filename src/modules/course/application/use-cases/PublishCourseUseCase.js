/**
 * PublishCourseUseCase — Caso de uso: Publicar un curso (activarlo).
 *
 * SRP: Solo orquesta la publicación/activación de un curso.
 * Emite CourseUpdatedEvent para notificaciones (desacoplado).
 */
import { Result } from '../../../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../../../shared/errors/index.js';
import { eventBus, CourseUpdatedEvent } from '../../../../shared/events/EventBus.js';

export class PublishCourseUseCase {
    constructor({ courseRepository }) {
        this.courseRepo = courseRepository;
    }

    /**
     * @param {object} input
     * @param {number} input.courseId — ID del curso a publicar.
     * @param {number} input.requesterId — ID del usuario.
     * @param {number[]} input.requesterRoles — Roles del usuario.
     * @returns {Promise<Result>}
     */
    async execute({ courseId, requesterId, requesterRoles = [] }) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) {
            return Result.fail(new NotFoundError('Curso', courseId));
        }

        const isAdmin = (requesterRoles || []).some(r => r === 3 || r === 4);
        if (!isAdmin) {
            return Result.fail(new ForbiddenError('Solo el rol 3 puede publicar cursos'));
        }
        const updated = await this.courseRepo.update(courseId, {
            isActive: true,
            is_active: true,
            isPublished: true,
            is_published: true,
        });
        // Emit domain event
        eventBus.publish(new CourseUpdatedEvent(updated || course, requesterId));

        return Result.ok(updated || course);
    }
}
export default PublishCourseUseCase;
