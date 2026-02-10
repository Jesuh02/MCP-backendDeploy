export class SupabaseSubscriptionRepository {
    constructor(client) { this.client = client; }

    async findBySubscriberAndCreator(subscriberId, creatorId) {
        const { data, error } = await this.client.from('subscriptions').select('*').eq('subscriber_id', subscriberId).eq('creator_id', creatorId).single();
        if (error || !data) return null;
        return data;
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
        const { data, error } = await this.client.from('subscriptions').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async delete(subscriberId, creatorId) {
        const { error } = await this.client.from('subscriptions').delete().eq('subscriber_id', subscriberId).eq('creator_id', creatorId);
        if (error) throw new Error(error.message);
        return true;
    }

    async countByCreator(creatorId) {
        const { count, error } = await this.client.from('subscriptions').select('*', { count: 'exact', head: true }).eq('creator_id', creatorId);
        return error ? 0 : count;
    }

    async countBySubscriber(subscriberId) {
        const { count, error } = await this.client.from('subscriptions').select('*', { count: 'exact', head: true }).eq('subscriber_id', subscriberId);
        return error ? 0 : count;
    }

    async findSubscriberIds(creatorId) {
        const { data, error } = await this.client.from('subscriptions').select('subscriber_id').eq('creator_id', creatorId);
        if (error || !data) return [];
        return data.map(s => s.subscriber_id);
    }
}
export default SupabaseSubscriptionRepository;