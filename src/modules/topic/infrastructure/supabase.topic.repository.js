export class SupabaseTopicRepository {
    constructor(client) { this.client = client; }

    async findAll(pg = {}) {
        const { offset = 0, limit = 20, sortOrder = 'asc' } = pg;
        const { data, error, count } = await this.client.from('topics').select('*', { count: 'exact' })
            .order('order_index', { ascending: sortOrder !== 'desc' })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return { topics: data || [], total: count || 0 };
    }

    async findById(id) {
        const { data, error } = await this.client.from('topics').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findBySubject(subjectId) {
        const { data, error } = await this.client.from('topics').select('*').eq('materia_id', subjectId).order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(topicData) {
        const payload = {
            name: topicData.title,
            description: topicData.description || '',
            materia_id: topicData.subjectId,
            order_index: topicData.orderIndex || 0,
        };
        if (topicData.createdBy) payload.created_by = topicData.createdBy;
        const { data, error } = await this.client.from('topics').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.title !== undefined) payload.name = data.title;
        if (data.description !== undefined) payload.description = data.description;
        if (data.orderIndex !== undefined) payload.order_index = data.orderIndex;
        if (data.updatedBy) payload.updated_by = data.updatedBy;
        payload.updated_at = new Date().toISOString();
        const { data: updated, error } = await this.client.from('topics').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return updated;
    }

    async delete(id) {
        // 1. Delete RAG documents with topic_id (fk_rag_documents_topic)
        await this.client.from('rag_documents').delete().eq('topic_id', id);

        // 2. Get all tasks for this topic
        const { data: tasks } = await this.client
            .from('tasks').select('id').eq('topic_id', id);
        const taskIds = (tasks || []).map(t => t.id);

        if (taskIds.length > 0) {
            // 3. Delete RAG documents tied to those tasks
            await this.client.from('rag_documents').delete().in('task_id', taskIds);

            // 4. Delete RAG documents tied to content items of those tasks, then the content items
            const { data: taskItems } = await this.client
                .from('content_items').select('id').in('task_id', taskIds);
            if (taskItems?.length > 0) {
                await this.client.from('rag_documents').delete()
                    .in('content_item_id', taskItems.map(i => i.id));
                await this.client.from('content_items').delete().in('task_id', taskIds);
            }

            // 5. Delete task submissions and question sessions for those tasks
            await this.client.from('task_submissions').delete().in('task_id', taskIds);
            await this.client.from('question_sessions').delete().in('task_id', taskIds);

            // 6. Delete the tasks
            await this.client.from('tasks').delete().eq('topic_id', id);
        }

        // 7. Delete content items directly under this topic (topic_id, no task)
        const { data: topicItems } = await this.client
            .from('content_items').select('id').eq('topic_id', id);
        if (topicItems?.length > 0) {
            await this.client.from('rag_documents').delete()
                .in('content_item_id', topicItems.map(i => i.id));
            await this.client.from('content_items').delete().eq('topic_id', id);
        }

        // 8. Delete the topic
        const { error } = await this.client.from('topics').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    // Deletes only the topic and its direct content items.
    // Tasks belonging to this topic are preserved (topic_id set to null).
    async deleteTopicOnly(id) {
        // 1. Delete RAG documents with topic_id
        await this.client.from('rag_documents').delete().eq('topic_id', id);

        // 2. Detach tasks from this topic (preserve them)
        await this.client.from('tasks').update({ topic_id: null }).eq('topic_id', id);

        // 3. Delete content items directly under this topic (no task)
        const { data: topicItems } = await this.client
            .from('content_items').select('id').eq('topic_id', id);
        if (topicItems?.length > 0) {
            await this.client.from('rag_documents').delete()
                .in('content_item_id', topicItems.map(i => i.id));
            await this.client.from('content_items').delete().eq('topic_id', id);
        }

        // 4. Delete the topic
        const { error } = await this.client.from('topics').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }
}
export default SupabaseTopicRepository;

