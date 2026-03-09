export class SupabaseContentItemRepository {
    constructor(client) { this.client = client; }

    async _deleteRagDocumentsByContentItemIds(contentItemIds = []) {
        const ids = (contentItemIds || []).filter((id) => Number.isInteger(id) || (typeof id === 'string' && id.trim() !== ''));
        if (ids.length === 0) return;

        const { error } = await this.client
            .from('rag_documents')
            .delete()
            .in('content_item_id', ids);

        if (error) throw new Error(error.message);
    }

    async _deleteRagDocumentsByTask(taskId) {
        const { error } = await this.client
            .from('rag_documents')
            .delete()
            .eq('task_id', taskId);

        if (error) throw new Error(error.message);
    }

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

    async findByCourse(courseId) {
        const { data: topics, error: topicErr } = await this.client
            .from('topics').select('id').eq('course_id', courseId);
        if (topicErr) throw new Error(topicErr.message);
        if (!topics || topics.length === 0) return [];
        const topicIds = topics.map(t => t.id);
        const { data, error } = await this.client
            .from('content_items').select('*')
            .in('topic_id', topicIds)
            .order('order_index', { ascending: true });
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
        // Delete dependent RAG rows first to satisfy FK constraint:
        // fk_rag_documents_content_item (rag_documents.content_item_id -> content_items.id)
        await this._deleteRagDocumentsByContentItemIds([id]);

        const { error } = await this.client.from('content_items').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async deleteByTask(taskId) {
        // 1) Collect content_item IDs for this task
        const { data: items, error: listError } = await this.client
            .from('content_items')
            .select('id')
            .eq('task_id', taskId);
        if (listError) throw new Error(listError.message);

        // 2) Delete RAG rows tied to task OR tied to those specific content items
        // task-level delete handles rows with content_item_id null
        await this._deleteRagDocumentsByTask(taskId);
        await this._deleteRagDocumentsByContentItemIds((items || []).map(i => i.id));

        // 3) Delete content items
        const { error } = await this.client.from('content_items').delete().eq('task_id', taskId);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseContentItemRepository;

