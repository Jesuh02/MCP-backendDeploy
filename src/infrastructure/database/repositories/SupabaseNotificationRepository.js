export class SupabaseNotificationRepository {
    constructor(client) {
        this.client = client;
        this.tableName = null;
    }

    async _resolveTableName() {
        if (this.tableName) return this.tableName;

        const candidates = ['notifications', 'notificaciones', 'notificacion'];
        for (const table of candidates) {
            const { error } = await this.client
                .from(table)
                .select('id', { count: 'exact', head: true })
                .limit(1);

            if (!error) {
                this.tableName = table;
                return this.tableName;
            }

            const msg = String(error.message || '').toLowerCase();
            const relationMissing = msg.includes('does not exist') || msg.includes('relation');
            if (!relationMissing) {
                this.tableName = table;
                return this.tableName;
            }
        }

        this.tableName = 'notifications';
        return this.tableName;
    }

    async findByUser(userId, { offset = 0, limit = 50 } = {}) {
        const table = await this._resolveTableName();
        const { data, error } = await this.client.from(table).select('*').eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
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
        const table = await this._resolveTableName();
        const { data, error } = await this.client.from(table).insert(payload).select().single();
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
        const table = await this._resolveTableName();
        const { error } = await this.client.from(table).update({ is_read: true }).eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async markAllAsRead(userId) {
        const table = await this._resolveTableName();
        const { error } = await this.client.from(table).update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
        if (error) throw new Error(error.message);
        return true;
    }

    async countUnread(userId) {
        const table = await this._resolveTableName();
        const { count, error } = await this.client.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false);
        return error ? 0 : count;
    }

    async delete(id) {
        const table = await this._resolveTableName();
        const { error } = await this.client.from(table).delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseNotificationRepository;

