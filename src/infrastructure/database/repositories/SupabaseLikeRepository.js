export class SupabaseLikeRepository {
    constructor(client) { this.client = client; }

    async findByUserAndEntity(userId, entityType, entityId) {
        const { data, error } = await this.client.from('likes').select('*').eq('usuario_id', userId).eq('entity_type', entityType).eq('entity_id', entityId).single();
        if (error || !data) return null;
        return data;
    }

    async create(likeData) {
        const payload = {
            usuario_id: likeData.userId,
            entity_type: likeData.entityType || 'video',
            entity_id: likeData.entityId,
        };
        const { data, error } = await this.client.from('likes').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async delete(userId, entityType, entityId) {
        const { error } = await this.client.from('likes').delete().eq('usuario_id', userId).eq('entity_type', entityType).eq('entity_id', entityId);
        if (error) throw new Error(error.message);
        return true;
    }

    async countByEntity(entityType, entityId) {
        const { count, error } = await this.client.from('likes').select('id', { count: 'exact', head: true }).eq('entity_type', entityType).eq('entity_id', entityId);
        return error ? 0 : count;
    }

    async findByUserAndEntities(userId, entityType, entityIds) {
        if (!entityIds || entityIds.length === 0) return [];
        const { data, error } = await this.client.from('likes').select('*').eq('usuario_id', userId).eq('entity_type', entityType).in('entity_id', entityIds);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseLikeRepository;
