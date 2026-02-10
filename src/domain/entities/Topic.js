/**
 * Topic — Entidad de dominio para Tema de un curso.
 */
export class Topic {
    constructor({ id = null, title, description = '', courseId, orderIndex = 0, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, title, description, courseId, orderIndex, createdAt, updatedAt });
    }

    static fromSupabaseRow(row) {
        return new Topic({
            id: row.id,
            title: row.title,
            description: row.description || '',
            courseId: row.course_id || row.courseId,
            orderIndex: row.order_index || row.orderIndex || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default Topic;