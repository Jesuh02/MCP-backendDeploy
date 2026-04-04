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

    async findByCourse(courseId, topicRepository) {
        let topicIds;
        if (topicRepository?.findByCourse) {
            const topics = await topicRepository.findByCourse(courseId);
            topicIds = (topics || []).map(t => t.id);
        } else {
            const { data: subjects, error: subErr } = await this.client
                .from('subjects').select('id').eq('course_id', courseId);
            if (subErr) throw new Error(subErr.message);
            if (!subjects || subjects.length === 0) return [];
            const subjectIds = subjects.map(s => s.id);
            const { data: topics, error: topicErr } = await this.client
                .from('topics').select('id').in('materia_id', subjectIds);
            if (topicErr) throw new Error(topicErr.message);
            topicIds = (topics || []).map(t => t.id);
        }
        if (topicIds.length === 0) return [];
        const { data, error } = await this.client
            .from('content_items').select('*')
            .in('topic_id', topicIds)
            .order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findDuplicate(itemData) {
        const title = itemData.title || itemData.fileName || '';
        const body = itemData.body || itemData.fileUri || itemData.content || '';
        const topicId = itemData.topicId || null;
        const taskId = itemData.taskId || null;

        let query = this.client.from('content_items').select('*');

        if (topicId) query = query.eq('topic_id', topicId);
        else query = query.is('topic_id', null);

        if (taskId) query = query.eq('task_id', taskId);
        else query = query.is('task_id', null);

        if (title) query = query.eq('title', title);
        if (body) query = query.eq('body', body);

        const { data, error } = await query.limit(1);
        if (error) return null;
        return data && data.length > 0 ? data[0] : null;
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
        // Persist file_uri and file_name so the public R2 URL is stored
        if (itemData.fileUri) payload.file_uri = itemData.fileUri;
        if (itemData.fileName || itemData.file_name) payload.file_name = itemData.fileName || itemData.file_name;
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
        if (updateData.fileUri !== undefined) payload.file_uri = updateData.fileUri;
        if (updateData.fileName !== undefined) payload.file_name = updateData.fileName;
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

