/**
 * SupabaseCourseRepository — Implementa ICourseRepository.
 */
export class SupabaseCourseRepository {
    constructor(client) { this.client = client; }

    _escapeOrIlikeValue(raw = '') {
        return String(raw)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/,/g, '\\,')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)');
    }

    async findById(id) {
        const { data, error } = await this.client
            .from('courses')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) {
            throw new Error(`Error consultando curso ${id}: ${error.message}`);
        }

        return data || null;
    }

    async findAll({ offset = 0, limit = 20, sortBy = 'created_at', sortOrder = 'desc', excludeCreatorId = null, activeOnly = false } = {}) {
        let query = this.client.from('courses').select('*');
        if (excludeCreatorId) query = query.neq('creator_user_id', excludeCreatorId);
        if (activeOnly) query = query.eq('is_active', true);

        const { data, error } = await query.order(sortBy, { ascending: sortOrder === 'asc' }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findByCreator(username, { offset = 0, limit = 20 } = {}) {
        // Resolve username to user ID first (courses table only has creator_user_id)
        const { data: user } = await this.client.from('usuarios').select('id').ilike('username', username).single();
        if (!user) return [];
        const { data, error } = await this.client.from('courses').select('*').eq('creator_user_id', user.id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findFree({ offset = 0, limit = 20, excludeCreatorId = null, activeOnly = false } = {}) {
        let query = this.client.from('courses').select('*').eq('is_premium', false);
        if (excludeCreatorId) query = query.neq('creator_user_id', excludeCreatorId);
        if (activeOnly) query = query.eq('is_active', true);

        const { data, error } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findPremium({ offset = 0, limit = 20, excludeCreatorId = null, activeOnly = false } = {}) {
        let query = this.client.from('courses').select('*').eq('is_premium', true);
        if (excludeCreatorId) query = query.neq('creator_user_id', excludeCreatorId);
        if (activeOnly) query = query.eq('is_active', true);

        const { data, error } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async search(query, { offset = 0, limit = 20, activeOnly = false } = {}) {
        const rawQuery = (query || '').trim();
        if (!rawQuery) return [];
        const safeQuery = this._escapeOrIlikeValue(rawQuery);
        const filter = `title.ilike."%${safeQuery}%",description.ilike."%${safeQuery}%"`;
        let q = this.client.from('courses').select('*').or(filter);
        if (activeOnly) q = q.eq('is_active', true);
        const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return data || [];
    }

    async create(courseData) {
        const payload = {
            title: courseData.title,
            description: courseData.description || '',
            thumbnail_uri: courseData.thumbnailUri || null,
            creator_user_id: courseData.creatorUserId || null,
            is_active: courseData.isActive ?? courseData.is_active ?? true,
            is_premium: courseData.isFree === false,
            price: courseData.price || 0,
            category: courseData.category || null,
            is_published: courseData.isPublished !== false,
            deadline: courseData.deadline ?? null,
        };
        const { data, error } = await this.client.from('courses').insert(payload).select().single();
        if (error) throw new Error(`Error creando curso: ${error.message}`);
        return data;
    }

    async update(id, data) {
        const payload = {};
        if (data.title !== undefined) payload.title = data.title;
        if (data.description !== undefined) payload.description = data.description;
        if (data.thumbnailUri !== undefined) payload.thumbnail_uri = data.thumbnailUri;
        if (data.isActive !== undefined || data.is_active !== undefined) payload.is_active = data.isActive ?? data.is_active;
        if (data.isFree !== undefined) payload.is_premium = data.isFree === false;
        if (data.price !== undefined) payload.price = data.price;
        if (data.category !== undefined) payload.category = data.category;
        if (data.isPublished !== undefined) payload.is_published = data.isPublished;
        if (data.deadline !== undefined) payload.deadline = data.deadline;
        if (data.lastModifiedBy !== undefined) payload.last_modified_by = data.lastModifiedBy;
        payload.last_modified_date = new Date().toISOString();

        const { data: updated, error } = await this.client.from('courses').update(payload).eq('id', id).select().single();
        if (error) throw new Error(`Error actualizando curso: ${error.message}`);
        return updated;
    }

    async delete(id) {
        // 1. Progress records
        await this.client.from('progreso_materia').delete().eq('curso_id', id);
        await this.client.from('progreso_curso').delete().eq('curso_id', id);

        // 2. Pre-enrollments (pending enrollment requests)
        await this.client.from('pre_enrollments').delete().eq('course_id', id);

        // 3. Certificates issued for this course
        await this.client.from('certificates').delete().eq('course_id', id);

        // 4. Subject access blocks (table has no course_id — resolve via subjects)
        const { data: sabSubjects } = await this.client.from('subjects').select('id').eq('course_id', id);
        if (sabSubjects?.length) {
            await this.client.from('subject_access_blocks').delete().in('subject_id', sabSubjects.map(s => s.id));
        }

        // 5. Reinforcement results
        await this.client.from('reinforcement_results').delete().eq('course_id', id);

        // 6. Questions history (direct course_id)
        await this.client.from('questions_history').delete().eq('course_id', id);

        // 7. RAG documents referencing this course directly
        await this.client.from('rag_documents').delete().eq('course_id', id);

        // 8. Transactions for this course
        await this.client.from('transactions').delete().eq('course_id', id);

        // 9. Collaborators
        await this.client.from('collaborators').delete().eq('course_id', id);

        // 10. Videos
        await this.client.from('videos').delete().eq('course_id', id);

        // 4. Cascade through subjects → topics → tasks/content_items/rag_documents/question_sessions
        const { data: subjects } = await this.client.from('subjects').select('id').eq('course_id', id);
        if (subjects && subjects.length > 0) {
            const subjectIds = subjects.map(s => s.id);

            // Topics linked by materia_id (FK: fk_topics_materia)
            const { data: topics } = await this.client.from('topics').select('id').in('materia_id', subjectIds);

            if (topics && topics.length > 0) {
                const topicIds = topics.map(t => t.id);

                // RAG docs for topics
                await this.client.from('rag_documents').delete().in('topic_id', topicIds);

                const { data: tasks } = await this.client.from('tasks').select('id').in('topic_id', topicIds);
                if (tasks && tasks.length > 0) {
                    const taskIds = tasks.map(t => t.id);

                    // RAG docs for tasks
                    await this.client.from('rag_documents').delete().in('task_id', taskIds);

                    // Content items under tasks → rag docs → delete
                    const { data: taskItems } = await this.client.from('content_items').select('id').in('task_id', taskIds);
                    if (taskItems && taskItems.length > 0) {
                        await this.client.from('rag_documents').delete().in('content_item_id', taskItems.map(i => i.id));
                        await this.client.from('content_items').delete().in('task_id', taskIds);
                    }

                    await this.client.from('task_submissions').delete().in('task_id', taskIds);

                    // Delete question_sessions children before the sessions
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
                    await this.client.from('tasks').delete().in('topic_id', topicIds);
                }

                // Content items directly on topics (no task)
                const { data: topicItems } = await this.client.from('content_items').select('id').in('topic_id', topicIds);
                if (topicItems && topicItems.length > 0) {
                    await this.client.from('rag_documents').delete().in('content_item_id', topicItems.map(i => i.id));
                    await this.client.from('content_items').delete().in('topic_id', topicIds);
                }

                await this.client.from('topics').delete().in('id', topicIds);
            }

            // Delete progreso_materia by materia_id to clear FK before dropping subjects
            await this.client.from('progreso_materia').delete().in('materia_id', subjectIds);

            // Safety-net: force-delete any remaining topics referencing these subjects
            await this.client.from('topics').delete().in('materia_id', subjectIds);

            const { error: subjectDeleteError } = await this.client.from('subjects').delete().eq('course_id', id);
            if (subjectDeleteError) throw new Error(`Error eliminando materias del curso: ${subjectDeleteError.message}`);
        }

        // 11. Finally delete the course
        const { error } = await this.client.from('courses').delete().eq('id', id);
        if (error) throw new Error(`Error eliminando curso: ${error.message}`);
        return true;
    }

    async updateActiveState(id, isActive) {
        const { data, error } = await this.client
            .from('courses')
            .update({
                is_active: Boolean(isActive),
                last_modified_date: new Date().toISOString(),
            })
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(`Error actualizando estado activo del curso: ${error.message}`);
        return data;
    }

    async deactivateCourses(ids = []) {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const { data, error } = await this.client
            .from('courses')
            .update({
                is_active: false,
                last_modified_date: new Date().toISOString(),
            })
            .in('id', ids)
            .select();
        if (error) throw new Error(`Error desactivando cursos expirados: ${error.message}`);
        return data || [];
    }

    async findExpired(nowIso = new Date().toISOString()) {
        const { data, error } = await this.client
            .from('courses')
            .select('*')
            .not('deadline', 'is', null)
            .lt('deadline', nowIso)
            .eq('is_active', true);
        if (error) throw new Error(`Error consultando cursos expirados: ${error.message}`);
        return data || [];
    }

    async existsByTitle(title) {
        const { count, error } = await this.client.from('courses').select('id', { count: 'exact', head: true }).ilike('title', title);
        return !error && count > 0;
    }

    async count(filters = {}) {
        let query = this.client.from('courses').select('id', { count: 'exact', head: true });
        if (filters.activeOnly) query = query.eq('is_active', true);
        if (filters.creatorUserId) query = query.eq('creator_user_id', filters.creatorUserId);
        if (filters.excludeCreatorId) query = query.neq('creator_user_id', filters.excludeCreatorId);
        if (filters.creatorUsername) {
            // Resolve username to user ID
            const { data: user } = await this.client.from('usuarios').select('id').ilike('username', filters.creatorUsername).single();
            if (user) query = query.eq('creator_user_id', user.id);
            else return 0;
        }
        if (filters.isFree !== undefined) query = query.eq('is_premium', !filters.isFree);
        if (filters.search) {
            const safeSearch = this._escapeOrIlikeValue(String(filters.search).trim());
            if (safeSearch) {
                query = query.or(`title.ilike."%${safeSearch}%",description.ilike."%${safeSearch}%"`);
            }
        }
        const { count, error } = await query;
        return error ? 0 : count;
    }

    async findByCreatorUserId(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').eq('creator_user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    /**
     * Devuelve únicamente los IDs de cursos creados por un usuario.
     * Consulta ligera — solo proyecta la columna `id`.
     * @param {number} creatorUserId
     * @returns {Promise<number[]>}
     */
    async findCourseIdsByCreatorUserId(creatorUserId) {
        const { data, error } = await this.client
            .from('courses')
            .select('id')
            .eq('creator_user_id', creatorUserId);
        if (error) {
            console.error('[CourseRepo] findCourseIdsByCreatorUserId error:', error.message);
            return [];
        }
        return (data || []).map(c => c.id);
    }

    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const { data, error } = await this.client.from('courses').select('*').in('id', ids);
        if (error) return [];
        return data || [];
    }

    async findFreeAll({ offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('courses').select('*').eq('is_premium', false).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    /**
     * Finds courses created by a specific user that have at least one task submission.
     * Used by ChatBot context filtering.
     * @param {number} creatorUserId
     * @returns {Promise<Object[]>}
     */
    async findCreatorCoursesWithSubmissions(creatorUserId) {
        // Step 1: Get creator's courses
        const { data: courses, error: coursesErr } = await this.client
            .from('courses')
            .select('*')
            .eq('creator_user_id', creatorUserId)
            .order('created_at', { ascending: false });

        if (coursesErr || !courses || courses.length === 0) return [];

        // Step 2: Get subjects for these courses
        const courseIds = courses.map(c => c.id);
        const { data: subjects } = await this.client
            .from('subjects')
            .select('id, course_id')
            .in('course_id', courseIds);

        if (!subjects || subjects.length === 0) return [];

        // Step 2b: Get topics for these subjects
        const subjectIds = subjects.map(s => s.id);
        const { data: topics } = await this.client
            .from('topics')
            .select('id, materia_id')
            .in('materia_id', subjectIds);

        if (!topics || topics.length === 0) return [];

        // Step 3: Get tasks for these topics
        const topicIds = topics.map(t => t.id);
        const { data: tasks } = await this.client
            .from('tasks')
            .select('id, topic_id')
            .in('topic_id', topicIds);

        if (!tasks || tasks.length === 0) return [];

        // Step 4: Check which tasks have submissions
        const taskIds = tasks.map(t => t.id);
        const { data: submissions } = await this.client
            .from('task_submissions')
            .select('task_id')
            .in('task_id', taskIds);

        if (!submissions || submissions.length === 0) return [];

        // Step 5: Map back to courses that have submissions
        const subjectByCourseId = new Map(subjects.map(s => [s.id, s.course_id]));
        const taskIdsWithSubs = new Set(submissions.map(s => s.task_id));
        const topicIdsWithSubs = new Set(
            tasks.filter(t => taskIdsWithSubs.has(t.id)).map(t => t.topic_id)
        );
        const subjectIdsWithSubs = new Set(
            topics.filter(t => topicIdsWithSubs.has(t.id)).map(t => t.materia_id)
        );
        const courseIdsWithSubs = new Set(
            subjects.filter(s => subjectIdsWithSubs.has(s.id)).map(s => s.course_id)
        );

        return courses.filter(c => courseIdsWithSubs.has(c.id));
    }
}
export default SupabaseCourseRepository;

