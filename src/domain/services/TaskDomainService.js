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
        let courseId = null;
        if (data.topicId) {
            const topic = await this.topicRepo.findById(data.topicId);
            if (!topic) return Result.fail(new NotFoundError('Tema', data.topicId));
            courseId = topic.course_id || topic.courseId || null;
        }
        const created = await this.taskRepo.create(data);

        if (courseId && this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            await this.progressService.recalculateForCourse(courseId);
        }

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
        this._scheduleTaskDeadlineReminder(task).catch(err =>
            console.error('[TaskDomainService] Error programando recordatorio de entrega:', err.message)
        );
        return createResult;
    }

    async updateAndNotify(id, data, _currentUser) {
        const updateResult = await this.update(id, data);
        if (updateResult.isFail()) return updateResult;

        const task = updateResult.getValue();
        if (!task?.dueDate) {
            this._cancelTaskDeadlineReminder(task).catch(err =>
                console.error('[TaskDomainService] Error cancelando recordatorio de entrega:', err.message)
            );
            return updateResult;
        }

        this._scheduleTaskDeadlineReminder(task).catch(err =>
            console.error('[TaskDomainService] Error reprogramando recordatorio de entrega:', err.message)
        );

        return updateResult;
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
        const enrollments = progressResult.getValue() || [];
        const enrolledUserIds = this._extractEnrollmentUserIds(enrollments);
        if (enrolledUserIds.length === 0) return;

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

        const currentUserId = Number(currentUser?.userId);
        const cleanTaskTitle = String(task?.title || 'Nueva actividad').trim();
        const cleanCourseTitle = String(course?.title || 'Curso').trim();

        const promises = enrolledUserIds.map(userId => {
            if (Number.isInteger(currentUserId) && currentUserId > 0 && userId === currentUserId) return Promise.resolve();
            return this.notificationService.sendNotification({
                userId,
                title: `Nueva tarea: ${cleanTaskTitle}`,
                message: `${senderUsername} publico una tarea en ${cleanCourseTitle}`,
                type: 'new_task',
                relatedId: task.id,
                senderUsername,
                senderAvatarUrl,
                thumbnailUrl: course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl,
                metadata: JSON.stringify({
                    taskId: task.id,
                    courseId,
                    taskTitle: cleanTaskTitle,
                    courseTitle: cleanCourseTitle,
                    style: 'minimal',
                    type: 'new_task'
                })
            });
        });
        await Promise.all(promises);
    }

    _extractEnrollmentUserIds(enrollments = []) {
        return [...new Set(
            enrollments
                .map(e => Number(e?.userId ?? e?.usuarioEstudiante ?? e?.user_id))
                .filter(userId => Number.isInteger(userId) && userId > 0)
        )];
    }

    async _scheduleTaskDeadlineReminder(task) {
        if (!this.notificationService || !this.progressService) return;
        if (!task?.dueDate) return;

        const dueDate = new Date(task.dueDate);
        if (Number.isNaN(dueDate.getTime())) return;

        const topicId = task.topicId || task.topic_id;
        if (!topicId) return;

        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return;

        const courseId = topic.course_id || topic.courseId;
        if (!courseId) return;

        const courseResult = this.courseService ? await this.courseService.getById(courseId) : null;
        const courseTitle = courseResult?.isOk?.() ? (courseResult.getValue()?.title || 'Curso') : 'Curso';

        const progressResult = await this.progressService.getAllByCourse(courseId);
        if (progressResult.isFail()) return;

        const enrollments = progressResult.getValue() || [];
        const userIds = this._extractEnrollmentUserIds(enrollments);

        if (userIds.length === 0) return;

        await this.notificationService.scheduleTaskReminderForUsers({
            taskId: task.id,
            userIds,
            taskTitle: task.title,
            courseTitle,
            dueDate: dueDate.toISOString()
        });
    }

    async _cancelTaskDeadlineReminder(task) {
        if (!this.notificationService || !this.progressService) return;
        if (!task?.id) return;

        const topicId = task.topicId || task.topic_id;
        if (!topicId) return;

        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return;

        const courseId = topic.course_id || topic.courseId;
        if (!courseId) return;

        const progressResult = await this.progressService.getAllByCourse(courseId);
        if (progressResult.isFail()) return;

        const userIds = this._extractEnrollmentUserIds(progressResult.getValue() || []);

        this.notificationService.cancelTaskReminderForUsers(task.id, userIds);
    }

    /** Actualiza una tarea existente. */
    async update(id, data) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));

        const originalTopicId = task.topicId || task.topic_id;
        const nextTopicId = data.topicId || originalTopicId;
        let originalCourseId = null;
        let nextCourseId = null;

        if (originalTopicId) {
            const originalTopic = await this.topicRepo.findById(originalTopicId);
            originalCourseId = originalTopic?.course_id || originalTopic?.courseId || null;
        }

        if (nextTopicId) {
            const topic = await this.topicRepo.findById(nextTopicId);
            nextCourseId = topic?.course_id || topic?.courseId || null;
        }

        const updated = await this.taskRepo.update(id, data);

        if (this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            const affectedCourseIds = [...new Set([originalCourseId, nextCourseId].filter(Boolean))];
            for (const courseId of affectedCourseIds) {
                await this.progressService.recalculateForCourse(courseId);
            }
        }

        return Result.ok(updated);
    }

    /** Elimina una tarea por ID. */
    async delete(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));

        const topicId = task.topicId || task.topic_id;
        let courseId = null;
        if (topicId) {
            const topic = await this.topicRepo.findById(topicId);
            courseId = topic?.course_id || topic?.courseId || null;
        }

        if (this.notificationService && task?.id) {
            try {
                await this._cancelTaskDeadlineReminder(task);
            } catch (err) {
                console.error('[TaskDomainService] Error cancelando recordatorios de tarea eliminada:', err.message);
            }
        }

        await this.taskRepo.delete(id);

        if (courseId && this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            await this.progressService.recalculateForCourse(courseId);
        }

        return Result.ok({ message: 'Tarea eliminada' });
    }
}
export default TaskDomainService;

