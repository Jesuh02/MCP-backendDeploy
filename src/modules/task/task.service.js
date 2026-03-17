import { Result } from '../../shared/Result.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/index.js';

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
    constructor({ taskRepository, topicRepository, subjectRepository, courseRepository, collaboratorRepository, notificationService, courseService, progressService, userService }) {
        this.taskRepo = taskRepository;
        this.topicRepo = topicRepository;
        this.subjectRepo = subjectRepository || null;
        this.courseRepo = courseRepository || null;
        this.collaboratorRepo = collaboratorRepository || null;
        this.notificationService = notificationService || null;
        this.courseService = courseService || null;
        this.progressService = progressService || null;
        this.userService = userService || null;
        this.cacheTtlMs = 30000;
        this.topicCache = new Map();
        this.subjectCache = new Map();
        this.tasksByTopicCache = new Map();
    }

    async _remember(cache, key, loader) {
        const now = Date.now();
        const entry = cache.get(key);
        if (entry && entry.expiresAt > now) return entry.value;
        const value = await loader();
        cache.set(key, { value, expiresAt: now + this.cacheTtlMs });
        return value;
    }

    async _getTopic(topicId) {
        if (!topicId) return null;
        return this._remember(this.topicCache, topicId, () => this.topicRepo.findById(topicId));
    }

    async _getSubject(subjectId) {
        if (!subjectId || !this.subjectRepo) return null;
        return this._remember(this.subjectCache, subjectId, () => this.subjectRepo.findById(subjectId));
    }

    async _getTasksByTopic(topicId) {
        if (!topicId) return [];
        return this._remember(this.tasksByTopicCache, topicId, () => this.taskRepo.findByTopic(topicId));
    }

    _invalidateTopic(topicId, subjectId) {
        if (topicId) {
            this.topicCache.delete(topicId);
            this.tasksByTopicCache.delete(topicId);
        }
        if (subjectId) this.subjectCache.delete(subjectId);
    }

    async _getCourseIdFromTopic(topic) {
        if (!topic) return null;
        const subjectId = topic.materia_id || topic.subject_id || topic.subjectId;
        if (!subjectId || !this.subjectRepo) return null;
        const subject = await this._getSubject(subjectId);
        return subject?.course_id || null;
    }

    async _getSubjectFromTopic(topic) {
        if (!topic) return null;
        const subjectId = topic.materia_id || topic.subject_id || topic.subjectId;
        return this._getSubject(subjectId);
    }

    async _canManageSubject(requesterId, subject) {
        if (!requesterId || !subject || !this.courseRepo) return false;

        const course = await this.courseRepo.findById(subject.course_id);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(requesterId)) return true;
        if (subject.created_by && Number(subject.created_by) === Number(requesterId)) return true;

        if (!this.collaboratorRepo) return false;
        const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, subject.course_id);
        return Boolean(isCollab && !subject.created_by);
    }

    _dedupeTasks(tasks = []) {
        const seen = new Set();
        return (tasks || []).filter(task => {
            const taskId = Number(task?.id);
            if (!Number.isInteger(taskId) || taskId <= 0 || seen.has(taskId)) return false;
            seen.add(taskId);
            return true;
        });
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
        const topic = await this._getTopic(topicId);
        if (!topic) return Result.fail(new NotFoundError('Tema', topicId));
        const tasks = this._dedupeTasks(await this._getTasksByTopic(topicId));
        return Result.ok(tasks);
    }

    /** Obtiene todas las tareas de un curso (via topics). */
    async getByCourse(courseId) {
        const tasks = this._dedupeTasks(await this.taskRepo.findByCourse(courseId));
        return Result.ok(tasks);
    }

    async getBySubject(subjectId) {
        const tasks = this._dedupeTasks(await this.taskRepo.findBySubject(subjectId));
        return Result.ok(tasks);
    }

    /** Crea una nueva tarea, validando que el tema exista. Previene duplicados. */
    async create(data, requesterId) {
        let courseId = null;
        let subjectId = null;
        let subject = null;
        if (data.topicId) {
            const topic = await this._getTopic(data.topicId);
            if (!topic) return Result.fail(new NotFoundError('Tema', data.topicId));
            subjectId = topic.materia_id || topic.subject_id || topic.subjectId || null;
            courseId = await this._getCourseIdFromTopic(topic);
            subject = await this._getSubjectFromTopic(topic);
        }

        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para crear tareas en esta materia'));
            data.createdBy = requesterId;
        }

        // Protección anti-duplicados: verificar si ya existe una tarea reciente con mismo título y tema
        if (data.topicId && data.title) {
            const existing = await this._getTasksByTopic(data.topicId);
            const duplicate = (existing || []).find(t => {
                const existingTitle = String(t.title || t.name || '').trim().toLowerCase();
                const nextTitle = String(data.title).trim().toLowerCase();
                if (existingTitle !== nextTitle) return false;
                const createdAt = new Date(t.createdAt || t.created_at);
                return (Date.now() - createdAt.getTime()) < 60000; // creada hace menos de 60 segundos
            });
            if (duplicate) {
                console.log(`[TaskDomainService] Duplicate task blocked: "${data.title}" in topic ${data.topicId}`);
                return Result.ok(duplicate);
            }
        }

        const created = await this.taskRepo.create(data);
        this._invalidateTopic(data.topicId, subjectId);

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
    async createAndNotify(data, requesterId, currentUser) {
        const createResult = await this.create(data, requesterId);
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

    async updateAndNotify(id, data, requesterId, _currentUser) {
        const updateResult = await this.update(id, data, requesterId);
        if (updateResult.isFail()) return updateResult;

        const task = updateResult.getValue();
        if (!task ?.dueDate) {
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

        const topic = await this._getTopic(topicId);
        if (!topic) return;
        const courseId = await this._getCourseIdFromTopic(topic);
        if (!courseId) return;

        const courseResult = await this.courseService.getById(courseId);
        if (courseResult.isFail()) return;
        const course = courseResult.getValue();

        const progressResult = await this.progressService.getAllByCourse(courseId);
        if (progressResult.isFail()) return;
        const enrollments = progressResult.getValue() || [];
        const enrolledUserIds = this._extractEnrollmentUserIds(enrollments);
        if (enrolledUserIds.length === 0) return;

        let senderUsername = currentUser ?.username || 'Instructor';
        let senderAvatarUrl = null;
        if (currentUser ?.userId && this.userService) {
            const userResult = await this.userService.getById(currentUser.userId);
            if (userResult.isOk()) {
                const u = userResult.getValue();
                senderUsername = u.username || senderUsername;
                senderAvatarUrl = u.avatar;
            }
        }

        const currentUserId = Number(currentUser ?.userId);
        const cleanTaskTitle = String(task ?.title || 'Nueva actividad').trim();
        const cleanCourseTitle = String(course ?.title || 'Curso').trim();

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
                thumbnailUrl: course.thumbnail_uri || course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl,
                metadata: JSON.stringify({
                    taskId: task.id,
                    courseId,
                    taskTitle: cleanTaskTitle,
                    courseTitle: cleanCourseTitle,
                    style: 'minimal',
                    type: 'new_task'
                }),
                actorUserId: currentUserId
            });
        });
        await Promise.all(promises);
    }

    _extractEnrollmentUserIds(enrollments = []) {
        return [...new Set(
            enrollments
            .map(e => Number(e ?.userId ?? e ?.usuarioEstudiante ?? e ?.user_id))
            .filter(userId => Number.isInteger(userId) && userId > 0)
        )];
    }

    async _scheduleTaskDeadlineReminder(task) {
        if (!this.notificationService || !this.progressService) return;
        if (!task ?.dueDate) return;

        const dueDate = new Date(task.dueDate);
        if (Number.isNaN(dueDate.getTime())) return;

        const topicId = task.topicId || task.topic_id;
        if (!topicId) return;

        const topic = await this._getTopic(topicId);
        if (!topic) return;

        const courseId = await this._getCourseIdFromTopic(topic);
        if (!courseId) return;

        const courseResult = this.courseService ? await this.courseService.getById(courseId) : null;
        const courseTitle = courseResult ?.isOk ?.() ? (courseResult.getValue() ?.title || 'Curso') : 'Curso';

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
        if (!task ?.id) return;

        const topicId = task.topicId || task.topic_id;
        if (!topicId) return;

        const topic = await this._getTopic(topicId);
        if (!topic) return;

        const courseId = await this._getCourseIdFromTopic(topic);
        if (!courseId) return;

        const progressResult = await this.progressService.getAllByCourse(courseId);
        if (progressResult.isFail()) return;

        const userIds = this._extractEnrollmentUserIds(progressResult.getValue() || []);

        this.notificationService.cancelTaskReminderForUsers(task.id, userIds);
    }

    /** Actualiza una tarea existente. */
    async update(id, data, requesterId) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));

        const permissionTopicId = task.topicId || task.topic_id;
        if (requesterId && permissionTopicId) {
            const permissionTopic = await this._getTopic(permissionTopicId);
            const permissionSubject = await this._getSubjectFromTopic(permissionTopic);
            const canManage = await this._canManageSubject(requesterId, permissionSubject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para editar esta tarea'));
            data.updatedBy = requesterId;
        }

        const originalTopicId = task.topicId || task.topic_id;
        const nextTopicId = data.topicId || originalTopicId;
        let originalCourseId = null;
        let nextCourseId = null;
        let originalSubjectId = null;
        let nextSubjectId = null;

        if (originalTopicId) {
            const originalTopic = await this._getTopic(originalTopicId);
            originalSubjectId = originalTopic?.materia_id || originalTopic?.subject_id || originalTopic?.subjectId || null;
            originalCourseId = originalTopic ?.course_id || originalTopic ?.courseId || null;
            if (!originalCourseId && originalTopic) {
                originalCourseId = await this._getCourseIdFromTopic(originalTopic);
            }
        }

        if (nextTopicId) {
            const topic = await this._getTopic(nextTopicId);
            nextSubjectId = topic?.materia_id || topic?.subject_id || topic?.subjectId || null;
            nextCourseId = topic ?.course_id || topic ?.courseId || null;
            if (!nextCourseId && topic) {
                nextCourseId = await this._getCourseIdFromTopic(topic);
            }
        }

        const updated = await this.taskRepo.update(id, data);
        this._invalidateTopic(originalTopicId, originalSubjectId);
        if (nextTopicId !== originalTopicId) {
            this._invalidateTopic(nextTopicId, nextSubjectId);
        }

        if (this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            const affectedCourseIds = [...new Set([originalCourseId, nextCourseId].filter(Boolean))];
            for (const courseId of affectedCourseIds) {
                await this.progressService.recalculateForCourse(courseId);
            }
        }

        return Result.ok(updated);
    }

    /** Elimina una tarea por ID. */
    async delete(id, requesterId) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));

        const topicId = task.topicId || task.topic_id;
        let courseId = null;
        let subjectId = null;
        if (topicId) {
            const topic = await this._getTopic(topicId);
            subjectId = topic?.materia_id || topic?.subject_id || topic?.subjectId || null;
            courseId = topic ?.course_id || topic ?.courseId || null;
            if (requesterId) {
                const subject = await this._getSubjectFromTopic(topic);
                const canManage = await this._canManageSubject(requesterId, subject);
                if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para eliminar esta tarea'));
            }
            if (!courseId && topic) {
                courseId = await this._getCourseIdFromTopic(topic);
            }
        }

        if (this.notificationService && task ?.id) {
            try {
                await this._cancelTaskDeadlineReminder(task);
            } catch (err) {
                console.error('[TaskDomainService] Error cancelando recordatorios de tarea eliminada:', err.message);
            }
        }

        await this.taskRepo.delete(id);
        this._invalidateTopic(topicId, subjectId);

        if (courseId && this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            await this.progressService.recalculateForCourse(courseId);
        }

        return Result.ok({ message: 'Tarea eliminada' });
    }
}
export default TaskDomainService;
