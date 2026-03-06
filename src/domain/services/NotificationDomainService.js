import { Result } from '../../shared/Result.js';

const TASK_REMINDER_OFFSET_MS = 5 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export class NotificationDomainService {
    constructor({ notificationRepository, userRepository, pushNotificationPort, emailPort, userService }) {
        this.notifRepo = notificationRepository;
        this.userRepo = userRepository;
        this.push = pushNotificationPort;
        this.email = emailPort;
        this.userService = userService || null;
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
            thumbnailUrl,
            metadata
        });

        // 2. Push notification
        if (this.push.isAvailable()) {
            const tokens = await this.userRepo.getUserFCMTokens(userId);
            if (tokens.length > 0) {
                const result = await this.push.sendToTokens(tokens, title, message, data || {});
                if (result.invalidTokens?.length > 0) {
                    await this.userRepo.removeInvalidFCMTokens(result.invalidTokens);
                }
            }
        }
        return Result.ok(notif);
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

        const subject = `Recordatorio: ${taskTitle} vence en 5 horas`;
        const text = `Hola ${user.username},\n\nTe recordamos que la actividad "${taskTitle}" del curso "${courseTitle}" vence el ${dueDateText}.\n\nTe recomendamos enviarla cuanto antes.\n`;
        const html = `
            <p>Hola <strong>${user.username}</strong>,</p>
            <p>Te recordamos que la actividad <strong>${taskTitle}</strong> del curso <strong>${courseTitle}</strong> vence el <strong>${dueDateText}</strong>.</p>
            <p>Te recomendamos enviarla cuanto antes.</p>
        `;

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

