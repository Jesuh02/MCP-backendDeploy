export class SupabaseNotificationRepository {
    constructor(client) { this.client = client; }

    async findByUser(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        return error ? [] : data || [];
    }

    async create(notifData) {
        const payload = {
            user_id: notifData.userId,
            title: notifData.title,
            message: notifData.message,
            type: notifData.type || 'generic',
            related_id: notifData.relatedId || notifData.related_id || null,
            sender_username: notifData.senderUsername || notifData.sender_username || null,
            sender_avatar_url: notifData.senderAvatarUrl || notifData.sender_avatar_url || null,
            thumbnail_url: notifData.thumbnailUrl || notifData.thumbnail_url || null,
            metadata: notifData.metadata || null,
            is_read: false,
        };
        const { data, error } = await this.client.from('notifications').insert(payload).select().single();
        if (error) {
            // Handle foreign key constraint violation (user_id not found)
            if (error.code === '23503') {
                throw new Error(`User with ID ${notifData.userId} does not exist.`);
            }
            throw new Error(error.message);
        }
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

