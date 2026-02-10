/**
 * Notification — Notificación push/email.
 */
export class Notification {
    constructor({ id = null, userId, title, message, type = 'generic', isRead = false, data = null, createdAt = null } = {}) {
        Object.assign(this, { id, userId, title, message, type, isRead, data, createdAt });
    }
    static fromSupabaseRow(row) {
        return new Notification({
            id: row.id,
            userId: row.user_id || row.userId,
            title: row.title,
            message: row.message,
            type: row.type || 'generic',
            isRead: row.is_read || false,
            data: row.data || null,
            createdAt: row.created_at,
        });
    }
}
export default Notification;