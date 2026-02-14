/**
 * INotificationRepository — Puerto de salida para notificaciones.
 * @interface
 */
export class INotificationRepository {
    async findByUser(userId, options) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async markAsRead(id) { throw new Error('Not implemented'); }
    async markAllAsRead(userId) { throw new Error('Not implemented'); }
    async countUnread(userId) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
}
export default INotificationRepository;

