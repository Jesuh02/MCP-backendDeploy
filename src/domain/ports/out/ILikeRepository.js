/**
 * ILikeRepository — Puerto de salida para likes polimórficos.
 * @interface
 */
export class ILikeRepository {
    async findByUserAndEntity(userId, entityType, entityId) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async delete(userId, entityType, entityId) { throw new Error('Not implemented'); }
    async countByEntity(entityType, entityId) { throw new Error('Not implemented'); }
    async findByUserAndEntities(userId, entityType, entityIds) { throw new Error('Not implemented'); }
}
export default ILikeRepository;