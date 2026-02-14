export class SupabaseContentItemRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('content_items').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByTask(taskId) {
        const { data, error } = await this.client.from('content_items').select('*').eq('task_id', taskId).order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByTopic(topicId) {
        const { data, error } = await this.client.from('content_items').select('*').eq('topic_id', topicId).order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(itemData) {
        const payload = {
            topic_id: itemData.topicId || null,
            task_id: itemData.taskId || null,
            title: itemData.title || itemData.fileName || '',
            body: itemData.body || itemData.fileUri || itemData.content || '',
            content_type: itemData.contentType || 'text',
            order_index: itemData.orderIndex || 0,
            creator_usuario_id: itemData.creatorUsuarioId || null,
            creator_username: itemData.creatorUsername || null,
        };
        const { data, error } = await this.client.from('content_items').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.title !== undefined) payload.title = updateData.title;
        if (updateData.body !== undefined) payload.body = updateData.body;
        if (updateData.contentType !== undefined) payload.content_type = updateData.contentType;
        if (updateData.orderIndex !== undefined) payload.order_index = updateData.orderIndex;
        const { data, error } = await this.client.from('content_items').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async delete(id) {
        const { error } = await this.client.from('content_items').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async deleteByTask(taskId) {
        const { error } = await this.client.from('content_items').delete().eq('task_id', taskId);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseContentItemRepository;

