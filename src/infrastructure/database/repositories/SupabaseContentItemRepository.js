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

    async create(itemData) {
        const payload = {
            task_id: itemData.taskId,
            topic_id: itemData.topicId || null,
            content_type: itemData.contentType || 'text',
            content: itemData.content || '',
            file_uri: itemData.fileUri || null,
            file_name: itemData.fileName || null,
            order_index: itemData.orderIndex || 0,
        };
        const { data, error } = await this.client.from('content_items').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.contentType !== undefined) payload.content_type = updateData.contentType;
        if (updateData.content !== undefined) payload.content = updateData.content;
        if (updateData.fileUri !== undefined) payload.file_uri = updateData.fileUri;
        if (updateData.fileName !== undefined) payload.file_name = updateData.fileName;
        if (updateData.orderIndex !== undefined) payload.order_index = updateData.orderIndex;
        payload.updated_at = new Date().toISOString();
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
