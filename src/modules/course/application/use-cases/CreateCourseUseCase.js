/**
 * CreateCourseUseCase — Caso de uso: Crear un nuevo curso.
 *
 * SRP: Solo orquesta la creación de un curso.
 * Emite CourseCreatedEvent para notificaciones (desacoplado).
 */
import { Result } from '../../../../shared/Result.js';
import { ForbiddenError } from '../../../../shared/errors/index.js';
import { eventBus, CourseCreatedEvent } from '../../../../shared/events/EventBus.js';

export class CreateCourseUseCase {
    constructor({ courseRepository, fileStoragePort }) {
        this.courseRepo = courseRepository;
        this.storage = fileStoragePort || null;
    }

    /**
     * @param {object} input
     * @param {object} input.courseData — Datos del curso a crear.
     * @param {number} input.requesterId — ID del usuario creador.
     * @param {number[]} input.requesterRoles — Roles del usuario.
     * @returns {Promise<Result>}
     */
    async execute({ courseData, requesterId, requesterRoles = [] }) {
        const isAdmin = (requesterRoles || []).some(r => r === 3 || r === 4);
        if (!isAdmin) {
            return Result.fail(new ForbiddenError('Solo el rol 3 puede crear cursos'));
        }

        courseData.creatorUserId = requesterId;

        // Ensure isFree is consistent with price
        const price = Number(courseData.price) || 0;
        courseData.isFree = price <= 0;
        courseData.isPremium = price > 0;
        courseData.is_premium = price > 0;

        // Defaults
        if (courseData.isActive === undefined) courseData.isActive = true;
        if (courseData.is_active === undefined) courseData.is_active = true;

        const created = await this.courseRepo.create(courseData);

        // Emit domain event (fire-and-forget notificaciones)
        eventBus.publish(new CourseCreatedEvent(created, requesterId));
        return Result.ok(created);
    }
}

export default CreateCourseUseCase;