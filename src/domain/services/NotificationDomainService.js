import { Result } from '../../shared/Result.js';

export class NotificationDomainService {
    constructor({ notificationRepository, userRepository, pushNotificationPort, emailPort }) {
        this.notifRepo = notificationRepository;
        this.userRepo = userRepository;
        this.push = pushNotificationPort;
        this.email = emailPort;
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

    async send(userId, { title, message, type, data }) {
        // 1. Guardar en BD
        const notif = await this.notifRepo.create({ userId, title, message, type, data });

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
    async sendBulk(userIds, { title, message, type, data }) {
        const results = [];
        for (const userId of userIds) {
            const result = await this.send(userId, { title, message, type, data });
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