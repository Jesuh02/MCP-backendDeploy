/**
 * ContentItem — Contenido adjunto a una tarea.
 */
export class ContentItem {
    constructor({ id = null, taskId, topicId = null, contentType = 'text', content = '', fileUri = null, fileName = null, orderIndex = 0, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, taskId, topicId, contentType, content, fileUri, fileName, orderIndex, createdAt, updatedAt });
    }
    static fromSupabaseRow(row) {
        return new ContentItem({
            id: row.id,
            taskId: row.task_id || row.taskId,
            topicId: row.topic_id || row.topicId || null,
            contentType: row.content_type || row.contentType || 'text',
            content: row.content || '',
            fileUri: row.file_uri || row.fileUri || null,
            fileName: row.file_name || row.fileName || null,
            orderIndex: row.order_index || row.orderIndex || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default ContentItem;

