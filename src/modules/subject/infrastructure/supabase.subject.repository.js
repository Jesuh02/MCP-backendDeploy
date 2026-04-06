export class SupabaseSubjectRepository {
    constructor(client) { this.client = client; }

    async findAll(pg = {}) {
        const { offset = 0, limit = 20, sortOrder = 'asc' } = pg;
        const { data, error, count } = await this.client.from('subjects').select('*', { count: 'exact' })
            .eq('is_active', true)
            .order('order_index', { ascending: sortOrder !== 'desc' })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return { subjects: data || [], total: count || 0 };
    }

    async findById(id) {
        const { data, error } = await this.client.from('subjects').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findByCourse(courseId, { activeOnly = true } = {}) {
        let query = this.client.from('subjects').select('*')
            .eq('course_id', courseId)
            .order('order_index', { ascending: true });
        if (activeOnly) query = query.eq('is_active', true);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(subjectData) {
        const payload = {
            course_id: subjectData.courseId,
            name: subjectData.name,
            description: subjectData.description || '',
            code: subjectData.code || null,
            thumbnail_url: subjectData.thumbnailUrl || null,
            order_index: subjectData.orderIndex ?? 0,
            is_active: subjectData.isActive ?? true,
            created_by: subjectData.createdBy || null,
        };
        const { data, error } = await this.client.from('subjects').insert(payload).select().single();
        if (error) throw new Error(error.message);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.name !== undefined) payload.name = data.name;
        if (data.description !== undefined) payload.description = data.description;
        if (data.code !== undefined) payload.code = data.code;
        if (data.thumbnailUrl !== undefined) payload.thumbnail_url = data.thumbnailUrl;
        if (data.orderIndex !== undefined) payload.order_index = data.orderIndex;
        if (data.isActive !== undefined) payload.is_active = data.isActive;
        if (data.updatedBy !== undefined) payload.updated_by = data.updatedBy;
        payload.updated_at = new Date().toISOString();
        const { data: updated, error } = await this.client.from('subjects').update(payload).eq('id', id).select().single();
        if (error) throw new Error(error.message);
        return updated;
    }

    async delete(id) {
        // 1. Cascade through topics linked to this subject (materia_id or subject_id)
        const { data: topics } = await this.client
            .from('topics').select('id')
            .or(`materia_id.eq.${id},subject_id.eq.${id}`);

        if (topics && topics.length > 0) {
            const topicIds = topics.map(t => t.id);

            await this.client.from('rag_documents').delete().in('topic_id', topicIds);

            const { data: tasks } = await this.client.from('tasks').select('id').in('topic_id', topicIds);
            if (tasks && tasks.length > 0) {
                const taskIds = tasks.map(t => t.id);

                await this.client.from('rag_documents').delete().in('task_id', taskIds);

                const { data: taskItems } = await this.client.from('content_items').select('id').in('task_id', taskIds);
                if (taskItems && taskItems.length > 0) {
                    await this.client.from('rag_documents').delete().in('content_item_id', taskItems.map(i => i.id));
                    await this.client.from('content_items').delete().in('task_id', taskIds);
                }

                const { data: subs } = await this.client.from('task_submissions').select('id').in('task_id', taskIds);
                const subIds = (subs || []).map(s => s.id);
                if (subIds.length > 0) {
                    await this.client.from('chat_messages').delete().in('submission_id', subIds);
                    await this.client.from('file_contexts').delete().in('submission_id', subIds);
                }
                await this.client.from('task_submissions').delete().in('task_id', taskIds);

                const { data: qSessions } = await this.client.from('question_sessions').select('id').in('task_id', taskIds);
                const qSessionIds = (qSessions || []).map(s => s.id);
                if (qSessionIds.length > 0) {
                    const { data: qHistory } = await this.client.from('questions_history').select('id').in('session_id', qSessionIds);
                    const qHistoryIds = (qHistory || []).map(h => h.id);
                    if (qHistoryIds.length > 0) {
                        await this.client.from('question_options').delete().in('question_id', qHistoryIds);
                    }
                    await this.client.from('questions_history').delete().in('session_id', qSessionIds);
                }
                await this.client.from('question_sessions').delete().in('task_id', taskIds);
                await this.client.from('tasks').delete().in('topic_id', topicIds);
            }

            const { data: topicItems } = await this.client.from('content_items').select('id').in('topic_id', topicIds);
            if (topicItems && topicItems.length > 0) {
                await this.client.from('rag_documents').delete().in('content_item_id', topicItems.map(i => i.id));
                await this.client.from('content_items').delete().in('topic_id', topicIds);
            }

            await this.client.from('reinforcement_question_history').delete().in('topic_id', topicIds);
            await this.client.from('reinforcement_results').delete().in('topic_id', topicIds);
            await this.client.from('question_sessions').delete().in('topic_id', topicIds);
            await this.client.from('topics').delete().in('id', topicIds);
        }

        // 2. Progress records for this subject
        await this.client.from('progreso_materia').delete().eq('materia_id', id);

        // 3. Subject access blocks
        await this.client.from('subject_access_blocks').delete().eq('subject_id', id);

        // 4. Subject collaborators
        await this.client.from('subject_collaborators').delete().eq('subject_id', id);

        // 5. Delete the subject itself
        const { error } = await this.client.from('subjects').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    // ── Subject collaborators ──────────────────────────────────────────────

    async findCollaboratorsBySubject(subjectId) {
        const { data, error } = await this.client
            .from('subject_collaborators')
            .select('*, usuarios(id, username, email, avatar)')
            .eq('subject_id', subjectId)
            .order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return (data || []).map(r => ({
            id: r.id,
            subjectId: r.subject_id,
            userId: r.user_id,
            createdAt: r.created_at,
            user: r.usuarios ? {
                id: r.usuarios.id,
                username: r.usuarios.username,
                email: r.usuarios.email,
                avatar: r.usuarios.avatar,
            } : null,
        }));
    }

    async isSubjectCollaborator(userId, subjectId) {
        const { count, error } = await this.client
            .from('subject_collaborators')
            .select('id', { count: 'exact', head: true })
            .eq('subject_id', subjectId)
            .eq('user_id', userId);
        return !error && count > 0;
    }

    async addSubjectCollaborator(subjectId, userId) {
        const { data, error } = await this.client
            .from('subject_collaborators')
            .upsert({ subject_id: subjectId, user_id: userId }, { onConflict: 'subject_id,user_id' })
            .select('*, usuarios(id, username, email, avatar)')
            .single();
        if (error) throw new Error(error.message);
        return {
            id: data.id,
            subjectId: data.subject_id,
            userId: data.user_id,
            createdAt: data.created_at,
            user: data.usuarios ? {
                id: data.usuarios.id,
                username: data.usuarios.username,
                email: data.usuarios.email,
                avatar: data.usuarios.avatar,
            } : null,
        };
    }

    async removeSubjectCollaborator(subjectId, userId) {
        const { error } = await this.client
            .from('subject_collaborators')
            .delete()
            .eq('subject_id', subjectId)
            .eq('user_id', userId);
        if (error) throw new Error(error.message);
        return true;
    }

    async syncSubjectCollaborators(subjectId, userIds) {
        await this.client.from('subject_collaborators').delete().eq('subject_id', subjectId);
        if (!userIds || userIds.length === 0) return [];
        const rows = userIds.map(uid => ({ subject_id: subjectId, user_id: uid }));
        const { data, error } = await this.client
            .from('subject_collaborators')
            .insert(rows)
            .select('*, usuarios(id, username, email, avatar)');
        if (error) throw new Error(error.message);
        return (data || []).map(r => ({
            id: r.id,
            subjectId: r.subject_id,
            userId: r.user_id,
            createdAt: r.created_at,
            user: r.usuarios ? {
                id: r.usuarios.id,
                username: r.usuarios.username,
                email: r.usuarios.email,
                avatar: r.usuarios.avatar,
            } : null,
        }));
    }
}
export default SupabaseSubjectRepository;
