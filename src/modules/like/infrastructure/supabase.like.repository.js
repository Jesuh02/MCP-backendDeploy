export class SupabaseLikeRepository {
    constructor(client) { this.client = client; }

    async findByUserAndEntity(userId, entityType, entityId) {
        // Select without .single() to detect duplicate rows from historical bugs.
        const { data, error } = await this.client.from('likes').select('*').eq('usuario_id', userId).eq('entity_type', entityType).eq('entity_id', entityId);
        if (error || !data || data.length === 0) return null;
        // Self-heal historical duplicates: keep only the oldest row so that toggle-off
        // decreases the count by exactly 1 instead of N (the dup count).
        if (data.length > 1) {
            const extraIds = data.slice(1).map(r => r.id).filter(id => id != null);
            if (extraIds.length > 0) {
                await this.client.from('likes').delete().in('id', extraIds);
            }
        }
        return data[0];
    }

    async create(likeData) {
        const payload = {
            usuario_id: likeData.userId,
            entity_type: likeData.entityType || 'video',
            entity_id: likeData.entityId,
        };
        // Defense in depth: wipe any pre-existing rows for this (user,entity) tuple
        // before inserting, so concurrent requests or stale state never produce
        // duplicates that would later cause the count to drop by more than 1.
        await this.client.from('likes')
            .delete()
            .eq('usuario_id', payload.usuario_id)
            .eq('entity_type', payload.entity_type)
            .eq('entity_id', payload.entity_id);
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
        const { count, error } = await this.client.from('likes').select('*', { count: 'exact', head: true }).eq('entity_type', entityType).eq('entity_id', entityId);
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

