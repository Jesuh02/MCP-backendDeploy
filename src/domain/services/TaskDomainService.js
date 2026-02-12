import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

/**
 * TaskDomainService — Servicio de dominio (casos de uso) para Tareas.
 *
 * Orquesta la lógica de negocio usando puertos inyectados:
 *   - taskRepository  (ITaskRepository)
 *   - topicRepository (ITopicRepository) — para validar existencia de temas
 *
 * No conoce detalles de infraestructura (Supabase, HTTP, etc.).
 */
export class TaskDomainService {
    /**
     * @param {object} deps
     * @param {import('../../domain/ports/out/ITaskRepository.js').ITaskRepository} deps.taskRepository
     * @param {import('../../domain/ports/out/ITopicRepository.js').ITopicRepository} deps.topicRepository
     * @param {import('./NotificationDomainService.js').NotificationDomainService} [deps.notificationService]
     * @param {import('./CourseDomainService.js').CourseDomainService} [deps.courseService]
     * @param {import('./ProgressDomainService.js').ProgressDomainService} [deps.progressService]
     * @param {import('./UserDomainService.js').UserDomainService} [deps.userService]
     */
    constructor({ taskRepository, topicRepository, notificationService, courseService, progressService, userService }) {
        this.taskRepo = taskRepository;
        this.topicRepo = topicRepository;
        this.notificationService = notificationService || null;
        this.courseService = courseService || null;
        this.progressService = progressService || null;
        this.userService = userService || null;
    }

    /** Lista paginada de tareas. */
    async list(pg) {
        const { tasks, total } = await this.taskRepo.findAll(pg);
        return Result.ok({ tasks, total });
    }

    /** Obtiene una tarea por ID. */
    async getById(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        return Result.ok(task);
    }

    /** Obtiene todas las tareas de un tema. */
    async getByTopic(topicId) {
        // Validar que el tema exista
        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return Result.fail(new NotFoundError('Tema', topicId));
        const tasks = await this.taskRepo.findByTopic(topicId);
        return Result.ok(tasks);
    }

    /** Obtiene todas las tareas de un curso (via topics). */
    async getByCourse(courseId) {
        const tasks = await this.taskRepo.findByCourse(courseId);
        return Result.ok(tasks);
    }

    /** Crea una nueva tarea, validando que el tema exista. */
    async create(data) {
        if (data.topicId) {
            const topic = await this.topicRepo.findById(data.topicId);
            if (!topic) return Result.fail(new NotFoundError('Tema', data.topicId));
        }
        const created = await this.taskRepo.create(data);
        return Result.ok(created);
    }

    /**
     * Crea una tarea y notifica a los estudiantes inscritos.
     * Orquesta la lógica de negocio que antes vivía en el controlador.
     * @param {object} data - Datos de la tarea
     * @param {object} [currentUser] - Usuario que crea la tarea (para excluirlo de la notificación)
     */
    async createAndNotify(data, currentUser) {
        const createResult = await this.create(data);
        if (createResult.isFail()) return createResult;

        const task = createResult.getValue();
        // Fire-and-forget: la notificación no bloquea la respuesta
        this._notifyNewTask(task, currentUser).catch(err =>
            console.error('[TaskDomainService] Error notificando nueva tarea:', err.message)
        );
        return createResult;
    }

    /**
     * Notifica a los estudiantes inscritos sobre una nueva tarea.
     * @private
     */
    async _notifyNewTask(task, currentUser) {
        if (!this.notificationService || !this.courseService || !this.progressService) return;

        const topicId = task.topicId || task.topic_id;
        if (!topicId) return;

        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return;
        const courseId = topic.course_id || topic.courseId;
        if (!courseId) return;

        const courseResult = await this.courseService.getById(courseId);
        if (courseResult.isFail()) return;
        const course = courseResult.getValue();

        const progressResult = await this.progressService.getAllByCourse(courseId);
        if (progressResult.isFail()) return;
        const enrollments = progressResult.getValue();
        if (!enrollments || enrollments.length === 0) return;

        let senderUsername = currentUser?.username || 'Instructor';
        let senderAvatarUrl = null;
        if (currentUser?.userId && this.userService) {
            const userResult = await this.userService.getById(currentUser.userId);
            if (userResult.isOk()) {
                const u = userResult.getValue();
                senderUsername = u.username || senderUsername;
                senderAvatarUrl = u.avatar;
            }
        }

        const promises = enrollments.map(e => {
            if (currentUser && e.userId === currentUser.userId) return Promise.resolve();
            return this.notificationService.sendNotification({
                userId: e.userId,
                title: `Nueva tarea: ${task.title}`,
                message: `${senderUsername} ha publicado una nueva tarea en '${course.title}'`,
                type: 'new_task',
                relatedId: task.id,
                senderUsername,
                senderAvatarUrl,
                thumbnailUrl: course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl,
                metadata: JSON.stringify({ taskId: task.id, courseId, type: 'new_task' })
            });
        });
        await Promise.all(promises);
    }

    /** Actualiza una tarea existente. */
    async update(id, data) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        const updated = await this.taskRepo.update(id, data);
        return Result.ok(updated);
    }

    /** Elimina una tarea por ID. */
    async delete(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        await this.taskRepo.delete(id);
        return Result.ok({ message: 'Tarea eliminada' });
    }
}
export default TaskDomainService;