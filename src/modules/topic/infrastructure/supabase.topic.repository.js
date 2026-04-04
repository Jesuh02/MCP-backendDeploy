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
        const { data, error } = await this.client.from('topics').select('*')
            .or(`materia_id.eq.${subjectId},subject_id.eq.${subjectId}`)
            .order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        const seen = new Set();
        return (data || []).filter(t => seen.has(t.id) ? false : seen.add(t.id));
    }

    async findByCourse(courseId) {
        const { data: subjects, error: subErr } = await this.client
            .from('subjects').select('id').eq('course_id', courseId);
        if (subErr) throw new Error(subErr.message);
        if (!subjects || subjects.length === 0) return [];

        const subjectIds = subjects.map(s => s.id);
        const orFilter = subjectIds.map(id => `materia_id.eq.${id},subject_id.eq.${id}`).join(',');
        const { data, error } = await this.client
            .from('topics').select('*')
            .or(orFilter)
            .order('order_index', { ascending: true });
        if (error) throw new Error(error.message);
        const seen = new Set();
        return (data || []).filter(t => seen.has(t.id) ? false : seen.add(t.id));
    }

    async create(topicData) {
        const payload = {
            name: topicData.title,
            description: topicData.description || '',
            materia_id: topicData.subjectId,
            subject_id: topicData.subjectId,
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
        if (data.subjectId !== undefined) {
            payload.materia_id = data.subjectId;
            payload.subject_id = data.subjectId;
        }
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

            // 5. Delete task submissions and question sessions (with children) for those tasks
            await this.client.from('task_submissions').delete().in('task_id', taskIds);

            // 5a. Delete question_sessions children before the sessions themselves
            const { data: qSessions } = await this.client
                .from('question_sessions').select('id').in('task_id', taskIds);
            const qSessionIds = (qSessions || []).map(s => s.id);
            if (qSessionIds.length > 0) {
                const { data: qHistory } = await this.client
                    .from('questions_history').select('id').in('session_id', qSessionIds);
                const qHistoryIds = (qHistory || []).map(h => h.id);
                if (qHistoryIds.length > 0) {
                    await this.client.from('question_options').delete().in('question_id', qHistoryIds);
                }
                await this.client.from('questions_history').delete().in('session_id', qSessionIds);
            }
            await this.client.from('question_sessions').delete().in('task_id', taskIds);

            // 5b. Delete reinforcement data tied to those tasks
            await this.client.from('reinforcement_question_history').delete().in('task_id', taskIds);
            await this.client.from('reinforcement_results').delete().in('task_id', taskIds);

            // 6. Delete the tasks
            const { error: tasksError } = await this.client.from('tasks').delete().eq('topic_id', id);
            if (tasksError) throw new Error(`Failed to delete tasks for topic ${id}: ${tasksError.message}`);
        }

        // 7. Delete content items directly under this topic (topic_id, no task)
        const { data: topicItems } = await this.client
            .from('content_items').select('id').eq('topic_id', id);
        if (topicItems?.length > 0) {
            await this.client.from('rag_documents').delete()
                .in('content_item_id', topicItems.map(i => i.id));
            await this.client.from('content_items').delete().eq('topic_id', id);
        }

        // 7b. Delete reinforcement data tied directly to this topic
        await this.client.from('reinforcement_question_history').delete().eq('topic_id', id);
        await this.client.from('reinforcement_results').delete().eq('topic_id', id);

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

        // 2b. Detach reinforcement data from this topic (preserve them)
        await this.client.from('reinforcement_question_history').update({ topic_id: null }).eq('topic_id', id);
        await this.client.from('reinforcement_results').update({ topic_id: null }).eq('topic_id', id);

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

