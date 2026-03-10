/**
 * Like — Like polimórfico (video, comentario, curso).
 */
export class Like {
    constructor({ id = null, userId, entityType = 'video', entityId, createdAt = null } = {}) {
        Object.assign(this, { id, userId, entityType, entityId, createdAt });
    }
    static fromSupabaseRow(row) {
        return new Like({
            id: row.id,
            userId: row.user_id || row.userId,
            entityType: row.entity_type || row.entityType || 'video',
            entityId: row.entity_id || row.entityId,
            createdAt: row.created_at,
        });
    }
}
export default Like;

