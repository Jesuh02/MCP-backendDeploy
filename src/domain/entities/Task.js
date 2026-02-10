/**
 * Task — Entidad de dominio para Tarea de un tema.
 */
export class Task {
    constructor({ id = null, title, description = '', topicId, courseId = null, dueDate = null, maxScore = 100, isActive = true, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, title, description, topicId, courseId, dueDate, maxScore, isActive, createdAt, updatedAt });
    }

    static fromSupabaseRow(row) {
        return new Task({
            id: row.id,
            title: row.title,
            description: row.description || '',
            topicId: row.topic_id || row.topicId,
            courseId: row.course_id || row.courseId || null,
            dueDate: row.due_date || row.dueDate || null,
            maxScore: row.max_score || row.maxScore || 100,
            isActive: row.is_active !== false,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default Task;