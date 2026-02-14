/**
 * ISubscriptionRepository — Puerto de salida para suscripciones.
 * @interface
 */
export class ISubscriptionRepository {
    async findBySubscriberAndCreator(subscriberId, creatorId) { throw new Error('Not implemented'); }
    async findBySubscriber(subscriberId) { throw new Error('Not implemented'); }
    async findByCreator(creatorId) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async delete(subscriberId, creatorId) { throw new Error('Not implemented'); }
    async countByCreator(creatorId) { throw new Error('Not implemented'); }
}
export default ISubscriptionRepository;

