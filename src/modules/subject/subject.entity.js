export class Subject {
    constructor({ id = null, courseId, name, description = '', code = null, thumbnailUrl = null, orderIndex = 0, isActive = true, createdAt = null, updatedAt = null, createdBy = null, updatedBy = null } = {}) {
        Object.assign(this, { id, courseId, name, description, code, thumbnailUrl, orderIndex, isActive, createdAt, updatedAt, createdBy, updatedBy });
    }

    static fromRow(row) {
        return new Subject({
            id: row.id,
            courseId: row.course_id,
            name: row.name,
            description: row.description || '',
            code: row.code,
            thumbnailUrl: row.thumbnail_url,
            orderIndex: row.order_index ?? 0,
            isActive: row.is_active ?? true,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            createdBy: row.created_by,
            updatedBy: row.updated_by,
        });
    }
}
export default Subject;
