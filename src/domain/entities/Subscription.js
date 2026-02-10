/**
 * Subscription — Suscripción creator ↔ subscriber.
 */
export class Subscription {
    constructor({ id = null, subscriberId, creatorId, createdAt = null } = {}) {
        Object.assign(this, { id, subscriberId, creatorId, createdAt });
    }
    static fromSupabaseRow(row) {
        return new Subscription({
            id: row.id,
            subscriberId: row.subscriber_id || row.subscriberId,
            creatorId: row.creator_id || row.creatorId,
            createdAt: row.created_at,
        });
    }
}
export default Subscription;