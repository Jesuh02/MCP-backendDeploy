import { Result } from '../../shared/Result.js';
import { generateTaskReminderEmailHTML } from '../../templates/index.js';

const TASK_REMINDER_OFFSET_MS = 5 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export class NotificationDomainService {
    constructor({ notificationRepository, userRepository, pushNotificationPort, emailPort, userService, courseRepository, topicRepository, taskRepository }) {
        this.notifRepo = notificationRepository;
        this.userRepo = userRepository;
        this.push = pushNotificationPort;
        this.email = emailPort;
        this.userService = userService || null;
        this.courseRepo = courseRepository || null;
        this.topicRepo = topicRepository || null;
        this.taskRepo = taskRepository || null;
        this.taskReminderTimers = new Map();
    }

    async getByUser(userId, pagination) {
        const notifs = await this.notifRepo.findByUser(userId, pagination);
        const unreadCount = await this.notifRepo.countUnread(userId);
        return Result.ok({ notifications: notifs, unreadCount });
    }

    async markAsRead(id) {
        await this.notifRepo.markAsRead(id);
        return Result.ok({ message: 'Notificación leída' });
    }

    async markAllAsRead(userId) {
        await this.notifRepo.markAllAsRead(userId);
        return Result.ok({ message: 'Todas las notificaciones leídas' });
    }

    async sendNotification({ userId, title, message, type, data, relatedId, senderUsername, senderAvatarUrl, thumbnailUrl, metadata }) {
        return this.send(userId, { title, message, type, data, relatedId, senderUsername, senderAvatarUrl, thumbnailUrl, metadata });
    }

    async send(userId, { title, message, type, data, relatedId, senderUsername, senderAvatarUrl, thumbnailUrl, metadata }) {
        // If global opt-out is enabled or this is a chat-originated notification, skip sending/storing
        const disableChatNotifications = process.env.DISABLE_CHAT_NOTIFICATIONS === 'true';
        const isChatType = type === 'chat_response' || (metadata && (metadata.channel === 'chat' || metadata.from === 'chat'));
        if (disableChatNotifications || isChatType) {
            console.log('[NotificationDomainService] Skipping chat notification (disabled or chat-type)');
            return Result.ok({ skipped: true });
        }

        let resolvedThumbnailUrl = thumbnailUrl;
        if (!resolvedThumbnailUrl) {
            resolvedThumbnailUrl = await this._resolveCourseThumbnail({ type, relatedId, metadata });
        }

        // 1. Guardar en BD
        const notif = await this.notifRepo.create({
            userId,
            title,
            message,
            type,
            data,
            relatedId,
            senderUsername,
            senderAvatarUrl,
            thumbnailUrl: resolvedThumbnailUrl,
            metadata
        });

        // 2. Push notification
        if (this.push.isAvailable()) {
            const tokens = await this.userRepo.getUserFCMTokens(userId);
            if (tokens.length > 0) {
                const pushData = this._buildPushData({
                    notificationId: notif?.id,
                    type,
                    relatedId,
                    senderUsername,
                    senderAvatarUrl,
                    thumbnailUrl: resolvedThumbnailUrl,
                    metadata,
                    ...data
                });
                const result = await this.push.sendToTokens(tokens, title, message, pushData);
                if (result.invalidTokens?.length > 0) {
                    await this.userRepo.removeInvalidFCMTokens(result.invalidTokens);
                }
            }
        }
        return Result.ok(notif);
    }

    _buildPushData(params) {
        const data = {};
        const stringFields = ['type', 'senderUsername', 'senderAvatarUrl', 'thumbnailUrl'];
        const numericFields = ['notificationId', 'relatedId', 'courseId', 'taskId', 'videoId', 'topicId'];

        for (const field of stringFields) {
            if (params[field] != null) data[field] = String(params[field]);
        }
        for (const field of numericFields) {
            if (params[field] != null) data[field] = String(params[field]);
        }

        const meta = this._normalizeMetadata(params.metadata);
        if (meta) {
            for (const field of numericFields) {
                const snakeField = field.replace(/([A-Z])/g, '_$1').toLowerCase();
                const value = meta[field] ?? meta[snakeField];
                if (value != null && !data[field]) data[field] = String(value);
            }
        }

        return data;
    }

    _normalizeMetadata(metadata) {
        if (!metadata) return null;
        if (typeof metadata === 'object') return metadata;

        if (typeof metadata === 'string') {
            const trimmed = metadata.trim();
            if (!trimmed) return null;
            try {
                return JSON.parse(trimmed);
            } catch {
                return null;
            }
        }

        return null;
    }

    _isCourseRelatedType(type) {
        const t = String(type || '').toLowerCase();
        return t === 'new_course' || t === 'new_task' || t === 'task_submission' || t === 'task_graded';
    }

    _getCourseIdFromMetadata(metadata) {
        const parsed = this._normalizeMetadata(metadata);
        if (!parsed) return null;

        const candidate = parsed.courseId ?? parsed.course_id ?? null;
        const courseId = Number(candidate);
        return Number.isInteger(courseId) && courseId > 0 ? courseId : null;
    }

    _getTaskIdFromMetadata(metadata) {
        const parsed = this._normalizeMetadata(metadata);
        if (!parsed) return null;

        const candidate = parsed.taskId ?? parsed.task_id ?? null;
        const taskId = Number(candidate);
        return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
    }

    async _resolveCourseIdFromTask(taskId) {
        if (!this.taskRepo || !this.topicRepo) return null;
        const numericTaskId = Number(taskId);
        if (!Number.isInteger(numericTaskId) || numericTaskId <= 0) return null;

        const task = await this.taskRepo.findById(numericTaskId);
        if (!task) return null;

        const topicId = Number(task.topicId ?? task.topic_id ?? 0);
        if (!Number.isInteger(topicId) || topicId <= 0) return null;

        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return null;

        const courseId = Number(topic.courseId ?? topic.course_id ?? 0);
        return Number.isInteger(courseId) && courseId > 0 ? courseId : null;
    }

    async _resolveCourseThumbnail({ type, relatedId, metadata }) {
        if (!this.courseRepo || !this._isCourseRelatedType(type)) return null;

        const normalizedType = String(type || '').toLowerCase();
        let courseId = this._getCourseIdFromMetadata(metadata);

        if (!courseId && normalizedType === 'new_course') {
            const id = Number(relatedId);
            if (Number.isInteger(id) && id > 0) courseId = id;
        }

        if (!courseId) {
            const taskIdFromMetadata = this._getTaskIdFromMetadata(metadata);
            if (taskIdFromMetadata) {
                courseId = await this._resolveCourseIdFromTask(taskIdFromMetadata);
            }
        }

        if (!courseId && normalizedType !== 'new_course') {
            const relatedTaskId = Number(relatedId);
            if (Number.isInteger(relatedTaskId) && relatedTaskId > 0) {
                courseId = await this._resolveCourseIdFromTask(relatedTaskId);
            }
        }

        if (!courseId) return null;

        const course = await this.courseRepo.findById(courseId);
        if (!course) return null;

        return course.thumbnail_uri || course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl || null;
    }
    async sendBulk(userIds, { title, message, type, data, relatedId, senderUsername, senderAvatarUrl, thumbnailUrl, metadata }) {
        const results = [];
        for (const userId of userIds) {
            const result = await this.send(userId, { title, message, type, data, relatedId, senderUsername, senderAvatarUrl, thumbnailUrl, metadata });
            results.push({ userId, success: result.isOk() });
        }
        return Result.ok(results);
    }

    async sendEmail(userId, { subject, html, text }) {
        const user = await this.userRepo.findById(userId);
        if (!user?.email) return Result.fail(new Error('Usuario sin email'));
        const sent = await this.email.sendEmail({ to: user.email, subject, html, text });
        return Result.ok({ sent });
    }

    _buildReminderKey(taskId, userId) {
        return `${taskId}:${userId}`;
    }

    _clearReminder(taskId, userId) {
        const key = this._buildReminderKey(taskId, userId);
        const timer = this.taskReminderTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.taskReminderTimers.delete(key);
        }
    }

    _scheduleTimeout(taskId, userId, delayMs, callback) {
        const key = this._buildReminderKey(taskId, userId);
        if (delayMs > MAX_TIMEOUT_MS) {
            const timer = setTimeout(() => {
                this.taskReminderTimers.delete(key);
                this._scheduleTimeout(taskId, userId, delayMs - MAX_TIMEOUT_MS, callback);
            }, MAX_TIMEOUT_MS);
            this.taskReminderTimers.set(key, timer);
            return;
        }

        const timer = setTimeout(async() => {
            this.taskReminderTimers.delete(key);
            try {
                await callback();
            } catch (err) {
                console.error('[NotificationDomainService] Error sending scheduled task reminder:', err.message);
            }
        }, Math.max(0, delayMs));

        this.taskReminderTimers.set(key, timer);
    }

    async _resolveUsersWithValidEmail(userIds = []) {
        if (this.userService && typeof this.userService.getValidatedEmailsByIds === 'function') {
            const validated = await this.userService.getValidatedEmailsByIds(userIds);
            if (validated?.isOk?.()) return validated.getValue();
        }

        const users = await this.userRepo.findByIds(userIds);
        return (users || [])
            .filter(u => u?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email).trim()))
            .map(u => ({ userId: u.id, email: u.email, username: u.username || 'Usuario' }));
    }

    async _sendTaskReminderEmail({ userId, taskTitle, courseTitle, dueDate }) {
        if (!this.email || !this.email.isAvailable || !this.email.isAvailable()) return;

        const resolvedUsers = await this._resolveUsersWithValidEmail([userId]);
        const user = resolvedUsers[0];
        if (!user) return;

        const dueDateText = new Date(dueDate).toLocaleString('es-CO', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });

        const fallbackTaskTitle = taskTitle || 'Actividad pendiente';
        const fallbackCourseTitle = courseTitle || 'Curso';
        const subject = `Recordatorio de entrega: ${fallbackTaskTitle}`;
        const text = [
            `Hola ${user.username},`,
            '',
            `Este es un recordatorio de entrega para la tarea "${fallbackTaskTitle}".`,
            `Curso: ${fallbackCourseTitle}.`,
            `Fecha limite: ${dueDateText}.`,
            '',
            'Si ya realizaste la entrega, puedes ignorar este mensaje.',
            '',
            'Equipo CourseV.'
        ].join('\n');
        const html = generateTaskReminderEmailHTML({
            userName: user.username,
            taskTitle: fallbackTaskTitle,
            courseTitle: fallbackCourseTitle,
            dueDateText,
            ctaUrl: process.env.FRONTEND_URL || process.env.APP_BASE_URL || ''
        });

        await this.email.sendEmail({ to: user.email, subject, text, html });
    }

    async scheduleTaskDeadlineReminder({ taskId, userId, taskTitle, courseTitle, dueDate }) {
        const parsedTaskId = Number(taskId);
        const parsedUserId = Number(userId);
        const due = new Date(dueDate);

        if (!Number.isInteger(parsedTaskId) || parsedTaskId <= 0) return Result.fail(new Error('taskId inválido'));
        if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) return Result.fail(new Error('userId inválido'));
        if (Number.isNaN(due.getTime())) return Result.fail(new Error('dueDate inválida'));

        this._clearReminder(parsedTaskId, parsedUserId);

        const reminderAt = due.getTime() - TASK_REMINDER_OFFSET_MS;
        const delayMs = reminderAt - Date.now();

        if (delayMs <= 0) {
            await this._sendTaskReminderEmail({ userId: parsedUserId, taskTitle, courseTitle, dueDate: due.toISOString() });
            return Result.ok({ scheduled: false, sentNow: true });
        }

        this._scheduleTimeout(parsedTaskId, parsedUserId, delayMs, async() => {
            await this._sendTaskReminderEmail({ userId: parsedUserId, taskTitle, courseTitle, dueDate: due.toISOString() });
        });

        return Result.ok({ scheduled: true, reminderAt: new Date(reminderAt).toISOString() });
    }

    cancelTaskDeadlineReminder(taskId, userId) {
        this._clearReminder(taskId, userId);
        return Result.ok({ cancelled: true });
    }

    async scheduleTaskReminderForUsers({ taskId, userIds = [], taskTitle, courseTitle, dueDate }) {
        const results = [];
        for (const userId of userIds) {
            const result = await this.scheduleTaskDeadlineReminder({ taskId, userId, taskTitle, courseTitle, dueDate });
            results.push({ userId, success: result.isOk() });
        }
        return Result.ok(results);
    }

    cancelTaskReminderForUsers(taskId, userIds = []) {
        for (const userId of userIds) {
            this.cancelTaskDeadlineReminder(taskId, userId);
        }
        return Result.ok({ cancelled: true, count: userIds.length });
    }

    async delete(id) {
        await this.notifRepo.delete(id);
        return Result.ok({ message: 'Notificación eliminada' });
    }

    async getUnreadCount(userId) {
        const count = await this.notifRepo.countUnread(userId);
        return Result.ok(count);
    }

    async sendToMultiple(userIds, notifData) {
        const results = await this.sendBulk(userIds, notifData);
        return results;
    }
}
export default NotificationDomainService;

