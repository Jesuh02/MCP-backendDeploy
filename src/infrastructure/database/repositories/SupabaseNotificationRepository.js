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
        if (error || !data) return [];

        const notifications = data || [];
        const videoTypes = new Set(['video_like', 'video_comment', 'comment_like', 'comment_reply', 'comment', 'like']);

        const videoIds = new Set();
        for (const notif of notifications) {
            const hasThumbnail = Boolean(notif.thumbnail_url);
            if (hasThumbnail || !videoTypes.has(String(notif.type || '').toLowerCase())) continue;

            const relatedId = Number(notif.related_id);
            if (Number.isFinite(relatedId) && relatedId > 0) {
                videoIds.add(relatedId);
                continue;
            }

            const metadataVideoId = this._extractVideoIdFromMetadata(notif.metadata);
            if (metadataVideoId) videoIds.add(metadataVideoId);
        }

        if (videoIds.size === 0) return notifications;

        const { data: videos } = await this.client
            .from('videos')
            .select('id, thumbnail_uri')
            .in('id', Array.from(videoIds));

        const thumbnailByVideoId = new Map((videos || []).map(v => [Number(v.id), v.thumbnail_uri || null]));

        return notifications.map(notif => {
            if (notif.thumbnail_url) return notif;

            const relatedId = Number(notif.related_id);
            let videoId = Number.isFinite(relatedId) && relatedId > 0 ? relatedId : null;
            if (!videoId) videoId = this._extractVideoIdFromMetadata(notif.metadata);
            if (!videoId) return notif;

            const thumbnail = thumbnailByVideoId.get(Number(videoId));
            if (!thumbnail) return notif;

            return {
                ...notif,
                thumbnail_url: thumbnail,
                thumbnailUrl: thumbnail,
            };
        });
    }

    _extractVideoIdFromMetadata(metadata) {
        if (!metadata) return null;

        try {
            const raw = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
            const normalized = raw.trim();
            const parsed = normalized.startsWith('{') ? JSON.parse(normalized) : null;

            if (parsed) {
                const candidate = parsed.video_id ?? parsed.videoId ?? null;
                const num = Number(candidate);
                if (Number.isFinite(num) && num > 0) return num;
            }

            const match = normalized.match(/(?:video_id|videoId)\s*[:=]\s*"?(\d+)"?/i);
            return match ? Number(match[1]) : null;
        } catch {
            return null;
        }
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

