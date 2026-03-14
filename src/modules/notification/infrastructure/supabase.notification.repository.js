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
        const courseTypes = new Set(['new_course', 'new_task', 'task_submission', 'task_graded']);

        const videoIds = new Set();
        const courseIds = new Set();
        const taskIds = new Set();
        for (const notif of notifications) {
            const hasThumbnail = Boolean(notif.thumbnail_url);
            const notifType = String(notif.type || '').toLowerCase();

            if (!hasThumbnail && videoTypes.has(notifType)) {
                const relatedId = Number(notif.related_id);
                if (Number.isFinite(relatedId) && relatedId > 0) {
                    videoIds.add(relatedId);
                } else {
                    const metadataVideoId = this._extractVideoIdFromMetadata(notif.metadata);
                    if (metadataVideoId) videoIds.add(metadataVideoId);
                }
            }

            if (hasThumbnail || !courseTypes.has(notifType)) continue;

            if (notifType === 'new_course') {
                const relatedCourseId = Number(notif.related_id);
                if (Number.isFinite(relatedCourseId) && relatedCourseId > 0) {
                    courseIds.add(relatedCourseId);
                }
                const metadataCourseId = this._extractCourseIdFromMetadata(notif.metadata);
                if (metadataCourseId) courseIds.add(metadataCourseId);
                continue;
            }

            const relatedId = Number(notif.related_id);
            if (Number.isFinite(relatedId) && relatedId > 0) {
                taskIds.add(relatedId);
            }

            const metadataCourseId = this._extractCourseIdFromMetadata(notif.metadata);
            if (metadataCourseId) courseIds.add(metadataCourseId);

            const metadataTaskId = this._extractTaskIdFromMetadata(notif.metadata);
            if (metadataTaskId) taskIds.add(metadataTaskId);
        }

        let thumbnailByVideoId = new Map();
        if (videoIds.size > 0) {
            const { data: videos } = await this.client
                .from('videos')
                .select('id, thumbnail_uri')
                .in('id', Array.from(videoIds));

            thumbnailByVideoId = new Map((videos || []).map(v => [Number(v.id), v.thumbnail_uri || null]));
        }

        const taskToCourseId = new Map();
        if (taskIds.size > 0) {
            const { data: tasks } = await this.client
                .from('tasks')
                .select('id, topic_id')
                .in('id', Array.from(taskIds));

            const topicIds = [...new Set((tasks || []).map(t => Number(t.topic_id)).filter(id => Number.isInteger(id) && id > 0))];
            if (topicIds.length > 0) {
                const { data: topics } = await this.client
                    .from('topics')
                    .select('id, materia_id')
                    .in('id', topicIds);

                const subjectIds = [...new Set((topics || []).map(t => Number(t.materia_id)).filter(id => Number.isInteger(id) && id > 0))];
                let subjectToCourseId = new Map();
                if (subjectIds.length > 0) {
                    const { data: subjects } = await this.client
                        .from('subjects')
                        .select('id, course_id')
                        .in('id', subjectIds);
                    subjectToCourseId = new Map((subjects || []).map(s => [Number(s.id), Number(s.course_id)]));
                }

                const courseIdByTopicId = new Map((topics || []).map(t => [Number(t.id), subjectToCourseId.get(Number(t.materia_id))]));
                for (const task of tasks || []) {
                    const taskId = Number(task.id);
                    const topicId = Number(task.topic_id);
                    const courseId = courseIdByTopicId.get(topicId);
                    if (Number.isInteger(taskId) && taskId > 0 && Number.isInteger(courseId) && courseId > 0) {
                        taskToCourseId.set(taskId, courseId);
                        courseIds.add(courseId);
                    }
                }
            }
        }

        let thumbnailByCourseId = new Map();
        if (courseIds.size > 0) {
            const { data: courses } = await this.client
                .from('courses')
                .select('id, thumbnail_uri')
                .in('id', Array.from(courseIds));

            thumbnailByCourseId = new Map((courses || []).map(c => [Number(c.id), c.thumbnail_uri || null]));
        }

        if (videoIds.size === 0 && courseIds.size === 0 && taskIds.size === 0) return notifications;

        return notifications.map(notif => {
            if (notif.thumbnail_url) return notif;

            const notifType = String(notif.type || '').toLowerCase();

            if (videoTypes.has(notifType)) {
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
            }

            if (!courseTypes.has(notifType)) return notif;

            let courseId = this._extractCourseIdFromMetadata(notif.metadata);
            if (!courseId && notifType === 'new_course') {
                const relatedCourseId = Number(notif.related_id);
                if (Number.isFinite(relatedCourseId) && relatedCourseId > 0) {
                    courseId = relatedCourseId;
                }
            }

            if (!courseId) {
                let taskId = this._extractTaskIdFromMetadata(notif.metadata);
                if (!taskId) {
                    const relatedId = Number(notif.related_id);
                    if (Number.isFinite(relatedId) && relatedId > 0) {
                        taskId = relatedId;
                    }
                }
                if (taskId) {
                    courseId = taskToCourseId.get(Number(taskId)) || null;
                }
            }

            if (!courseId) return notif;

            const courseThumbnail = thumbnailByCourseId.get(Number(courseId));
            if (!courseThumbnail) return notif;

            return {
                ...notif,
                thumbnail_url: courseThumbnail,
                thumbnailUrl: courseThumbnail,
            };
        });
    }

    _normalizeMetadata(metadata) {
        if (!metadata) return null;
        if (typeof metadata === 'object') return metadata;

        try {
            const raw = String(metadata).trim();
            if (!raw) return null;
            return raw.startsWith('{') ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    _extractCourseIdFromMetadata(metadata) {
        const parsed = this._normalizeMetadata(metadata);
        if (!parsed) return null;

        const num = Number(parsed.course_id ?? parsed.courseId ?? null);
        return Number.isFinite(num) && num > 0 ? num : null;
    }

    _extractTaskIdFromMetadata(metadata) {
        const parsed = this._normalizeMetadata(metadata);
        if (!parsed) return null;

        const num = Number(parsed.task_id ?? parsed.taskId ?? null);
        return Number.isFinite(num) && num > 0 ? num : null;
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

