export class SupabaseSubscriptionRepository {
    constructor(client) { this.client = client; }

    _normalizeId(value) {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    async findBySubscriberAndCreator(subscriberId, creatorId) {
        const normalizedSubscriberId = this._normalizeId(subscriberId);
        const normalizedCreatorId = this._normalizeId(creatorId);
        if (!normalizedSubscriberId || !normalizedCreatorId) return null;

        const { data, error } = await this.client
            .from('subscriptions')
            .select('*')
            .eq('subscriber_id', normalizedSubscriberId)
            .eq('creator_id', normalizedCreatorId)
            .order('created_at', { ascending: false })
            .limit(1);
        if (error || !Array.isArray(data) || data.length === 0) return null;
        return data[0];
    }

    async findBySubscriber(subscriberId) {
        const { data, error } = await this.client.from('subscriptions').select('*').eq('subscriber_id', subscriberId).order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async findByCreator(creatorId) {
        const { data, error } = await this.client.from('subscriptions').select('*').eq('creator_id', creatorId).order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async create(subData) {
        const payload = {
            subscriber_id: subData.subscriberId,
            creator_id: subData.creatorId,
        };

        const existing = await this.findBySubscriberAndCreator(subData.subscriberId, subData.creatorId);
        if (existing) return existing;

        const { data, error } = await this.client
            .from('subscriptions')
            .upsert(payload, { onConflict: 'subscriber_id,creator_id' })
            .select()
            .single();

        if (error) {
            const duplicate = String(error.message || '').toLowerCase();
            if (duplicate.includes('duplicate') || duplicate.includes('unique') || duplicate.includes('23505')) {
                const found = await this.findBySubscriberAndCreator(subData.subscriberId, subData.creatorId);
                if (found) return found;
            }
            throw new Error(error.message);
        }

        return data;
    }

    async delete(subscriberId, creatorId) {
        const { error } = await this.client.from('subscriptions').delete().eq('subscriber_id', subscriberId).eq('creator_id', creatorId);
        if (error) throw new Error(error.message);
        return true;
    }

    async countByCreator(creatorId) {
        const normalizedCreatorId = this._normalizeId(creatorId);
        if (!normalizedCreatorId) return 0;
        const { count, error } = await this.client.from('subscriptions').select('*', { count: 'exact', head: true }).eq('creator_id', normalizedCreatorId);
        return error ? 0 : count;
    }

    async countBySubscriber(subscriberId) {
        const normalizedSubscriberId = this._normalizeId(subscriberId);
        if (!normalizedSubscriberId) return 0;
        const { count, error } = await this.client.from('subscriptions').select('*', { count: 'exact', head: true }).eq('subscriber_id', normalizedSubscriberId);
        return error ? 0 : count;
    }

    async findSubscriberIds(creatorId) {
        const { data, error } = await this.client.from('subscriptions').select('subscriber_id').eq('creator_id', creatorId);
        if (error || !data) return [];
        return data.map(s => s.subscriber_id);
    }
}
export default SupabaseSubscriptionRepository;

