export class SupabaseNotificationRepository {
    constructor(client) { this.client = client; }

    async findByUser(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        return error ? [] : data || [];
    }

    async create(notifData) {
        const { data, error } = await this.client.from('notifications').insert({
            user_id: notifData.userId,
            title: notifData.title,
            message: notifData.message,
            type: notifData.type || 'generic',
            data: notifData.data || null,
        }).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async markAsRead(id) {
        const { error } = await this.client.from('notifications').update({ is_read: true }).eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async markAllAsRead(userId) {
        const { error } = await this.client.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
        if (error) throw new Error(error.message);
        return true;
    }

    async countUnread(userId) {
        const { count, error } = await this.client.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false);
        return error ? 0 : count;
    }

    async delete(id) {
        const { error } = await this.client.from('notifications').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseNotificationRepository;