import { Result } from '../../shared/Result.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { generateGenericEmailHTML } from '../../templates/emailTemplates.js';

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
    constructor({ taskRepository, topicRepository, subjectRepository, courseRepository, collaboratorRepository, notificationService, courseService, progressService, userService, periodRepository }) {
        this.taskRepo = taskRepository;
        this.topicRepo = topicRepository;
        this.subjectRepo = subjectRepository || null;
        this.courseRepo = courseRepository || null;
        this.collaboratorRepo = collaboratorRepository || null;
        this.notificationService = notificationService || null;
        this.courseService = courseService || null;
        this.progressService = progressService || null;
        this.userService = userService || null;
        this.periodRepo = periodRepository || null;
        this.cacheTtlMs = 60000;
        this.taskCache = new Map();
        this.topicCache = new Map();
        this.subjectCache = new Map();
        this.tasksByCourseCache = new Map();
        this.tasksBySubjectCache = new Map();
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

    async _getTask(taskId) {
        if (!taskId) return null;
        return this._remember(this.taskCache, taskId, () => this.taskRepo.findById(taskId));
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

    async _getTasksByCourse(courseId) {
        if (!courseId) return [];
        return this._remember(this.tasksByCourseCache, courseId, () => this.taskRepo.findByCourse(courseId));
    }

    async _getTasksBySubject(subjectId) {
        if (!subjectId) return [];
        return this._remember(this.tasksBySubjectCache, subjectId, () => this.taskRepo.findBySubject(subjectId));
    }

    _invalidateTaskCaches({ taskId, topicId, subjectId, courseId } = {}) {
        if (taskId) this.taskCache.delete(taskId);
        if (topicId) {
            this.topicCache.delete(topicId);
            this.tasksByTopicCache.delete(topicId);
        }
        if (subjectId) {
            this.subjectCache.delete(subjectId);
            this.tasksBySubjectCache.delete(subjectId);
        }
        if (courseId) this.tasksByCourseCache.delete(courseId);
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
        return Boolean(isCollab);
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
        const task = await this._getTask(id);
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
        const tasks = this._dedupeTasks(await this._getTasksByCourse(courseId));
        return Result.ok(tasks);
    }

    async getBySubject(subjectId) {
        const tasks = this._dedupeTasks(await this._getTasksBySubject(subjectId));
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

        // Auto-resolve periodo activo para asociar la tarea al periodo correcto.
        // Si el cliente no envió periodId y tenemos un subject, buscamos el periodo activo.
        // Si no hay periodo activo, usamos el más reciente (último cerrado).
        if (data.periodId == null && subjectId && this.periodRepo) {
            try {
                let resolvedPeriodId = null;
                const activePeriod = await this.periodRepo.findActiveBySubject(subjectId);
                if (activePeriod) {
                    resolvedPeriodId = activePeriod.id;
                } else {
                    // Sin periodo activo → asignar al periodo más reciente
                    const allPeriods = await this.periodRepo.findBySubject(subjectId);
                    if (allPeriods && allPeriods.length > 0) {
                        // findBySubject devuelve ordenado por period_number ASC; tomamos el último
                        resolvedPeriodId = allPeriods[allPeriods.length - 1].id;
                    }
                }
                if (resolvedPeriodId != null) data.periodId = resolvedPeriodId;
            } catch (err) {
                // No bloquear la creación si falla la resolución del periodo
                console.warn('[TaskDomainService] Could not resolve period for task:', err.message);
            }
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
        this._invalidateTaskCaches({ taskId: created?.id, topicId: data.topicId, subjectId, courseId });

        if (courseId && this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            // Fire-and-forget: don't block the response
            this.progressService.recalculateForCourse(courseId).catch(err =>
                console.error('[TaskDomainService] Error recalculating progress after create:', err.message)
            );
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

        const title = `Nueva tarea: ${cleanTaskTitle}`;
        const message = `${senderUsername} publico una tarea en ${cleanCourseTitle}`;
        const thumbnailUrl = course.thumbnail_uri || course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl;
        const metadata = JSON.stringify({
            taskId: task.id,
            courseId,
            taskTitle: cleanTaskTitle,
            courseTitle: cleanCourseTitle,
            style: 'minimal',
            type: 'new_task'
        });
        const html = generateGenericEmailHTML(title, message, 'new_task', senderUsername);

        await Promise.all([
            this.notificationService.sendBulk(enrolledUserIds, {
                title,
                message,
                type: 'new_task',
                relatedId: task.id,
                senderUsername,
                senderAvatarUrl,
                thumbnailUrl,
                metadata,
                actorUserId: currentUserId
            }),
            this.notificationService.sendEmailBulk(enrolledUserIds, {
                subject: title,
                html,
                text: message,
                actorUserId: currentUserId
            })
        ]);
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

        const subject = await this._getSubjectFromTopic(topic);
        const subjectTitle = subject ?.title || subject ?.name || null;

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
            subjectTitle,
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

    /**
     * Restaura los recordatorios de entrega de todas las tareas con fecha futura.
     * Debe llamarse al arrancar el servidor para recuperar timers perdidos en reinicios.
     */
    async restoreTaskReminders() {
        if (!this.taskRepo?.findWithFutureDueDate || !this.notificationService || !this.progressService) return;
        try {
            const tasks = await this.taskRepo.findWithFutureDueDate();
            let scheduled = 0;
            for (const task of tasks) {
                await this._scheduleTaskDeadlineReminder(task).catch(err =>
                    console.error(`[TaskDomainService] Error restaurando recordatorio tarea ${task.id}:`, err.message)
                );
                scheduled++;
            }
            console.log(`[TaskDomainService] Recordatorios restaurados: ${scheduled} tarea(s) reprogramada(s).`);
        } catch (err) {
            console.error('[TaskDomainService] Error al restaurar recordatorios de entrega:', err.message);
        }
    }

    /** Actualiza una tarea existente. */
    async update(id, data, requesterId) {
        const task = await this._getTask(id);
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
        this._invalidateTaskCaches({ taskId: id, topicId: originalTopicId, subjectId: originalSubjectId, courseId: originalCourseId });
        if (nextTopicId !== originalTopicId) {
            this._invalidateTaskCaches({ taskId: id, topicId: nextTopicId, subjectId: nextSubjectId, courseId: nextCourseId });
        }

        if (this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            const affectedCourseIds = [...new Set([originalCourseId, nextCourseId].filter(Boolean))];
            // Fire-and-forget: don't block the response
            Promise.allSettled(
                affectedCourseIds.map(cid => this.progressService.recalculateForCourse(cid))
            ).catch(err => console.error('[TaskDomainService] Error recalculating progress after update:', err.message));
        }

        return Result.ok(updated);
    }

    /** Actualiza solo el orden visual de un conjunto de tareas. */
    async reorder(items, requesterId) {
        const normalized = (items || [])
            .map(item => ({ id: Number(item.id), orderIndex: Number(item.orderIndex) }))
            .filter(item => Number.isInteger(item.id) && item.id > 0 && Number.isInteger(item.orderIndex) && item.orderIndex >= 0);

        if (normalized.length === 0) return Result.ok([]);

        const affected = [];
        for (const item of normalized) {
            const task = await this._getTask(item.id);
            if (!task) return Result.fail(new NotFoundError('Tarea', item.id));

            const topicId = task.topicId || task.topic_id;
            const topic = topicId ? await this._getTopic(topicId) : null;
            const subject = await this._getSubjectFromTopic(topic);

            if (requesterId) {
                const canManage = await this._canManageSubject(requesterId, subject);
                if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para ordenar estas tareas'));
            }

            const subjectId = topic?.materia_id || topic?.subject_id || topic?.subjectId || null;
            let courseId = topic?.course_id || topic?.courseId || null;
            if (!courseId && topic) courseId = await this._getCourseIdFromTopic(topic);
            affected.push({ taskId: item.id, topicId, subjectId, courseId });
        }

        const updated = await this.taskRepo.updateOrder(normalized);
        for (const entry of affected) {
            this._invalidateTaskCaches(entry);
        }

        return Result.ok(updated);
    }

    /** Elimina una tarea por ID. */
    async delete(id, requesterId) {
        const task = await this._getTask(id);
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
        this._invalidateTaskCaches({ taskId: id, topicId, subjectId, courseId });

        if (courseId && this.progressService && typeof this.progressService.recalculateForCourse === 'function') {
            // Fire-and-forget: don't block the response
            this.progressService.recalculateForCourse(courseId).catch(err =>
                console.error('[TaskDomainService] Error recalculating progress after delete:', err.message)
            );
        }

        return Result.ok({ message: 'Tarea eliminada' });
    }
}
export default TaskDomainService;
