import { Task } from '../task.entity.js';

/**
 * SupabaseTaskRepository � Adaptador de salida (infraestructura).
 *
 * Implementa ITaskRepository usando el cliente de Supabase.
 * Responsabilidades:
 *   1. Ejecutar queries contra la tabla `tasks`.
 *   2. Mapear filas snake_case a entidades de dominio camelCase via Task.fromSupabaseRow().
 *   3. Mapear datos de dominio camelCase a snake_case para inserts / updates.
 *
 * Tabla `tasks` (columnas reales):
 *   id | topic_id | title | description | due_date | time_limit_minutes | created_at
 *
 * Nota: NO existe `course_id` en `tasks`; la relaci�n con cursos va
 *       tasks.topic_id → topics.materia_id → subjects.course_id. Los métodos que necesitan filtrar
 *       por curso hacen join a través de `subjects` y `topics`.
 */
export class SupabaseTaskRepository {
    constructor(client) { this.client = client; }

    // -- Helpers de mapeo -------------------------------------

    /** Convierte una fila de Supabase en una entidad de dominio. */
    _toDomain(row) {
        return row ? Task.fromSupabaseRow(row) : null;
    }

    /** Convierte un arreglo de filas en entidades de dominio. */
    _toDomainList(rows) {
        return (rows || []).map(r => Task.fromSupabaseRow(r));
    }

    // -- Queries ----------------------------------------------

    async findAll(pg = {}) {
        const { offset = 0, limit = 20, sortOrder = 'desc' } = pg;
        const { data, error, count } = await this.client
            .from('tasks')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: sortOrder === 'asc' })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return { tasks: this._toDomainList(data), total: count || 0 };
    }

    async findById(id) {
        const { data, error } = await this.client
            .from('tasks')
            .select('*')
            .eq('id', id)
            .single();
        if (error || !data) return null;
        return this._toDomain(data);
    }

    async findByTopic(topicId) {
        const { data, error } = await this.client
            .from('tasks')
            .select('*')
            .eq('topic_id', topicId)
            .order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return this._toDomainList(data);
    }

    /**
     * Busca todas las tareas de un curso.
     * Como `tasks` no tiene `course_id`, se resuelve a trav�s de `topics`:
     *   1. Obtener los topic IDs del curso.
     *   2. Filtrar tareas por esos topic IDs.
     */
    async findByCourse(courseId) {
        const { data: subjects, error: subErr } = await this.client
            .from('subjects').select('id').eq('course_id', courseId);
        if (subErr) throw new Error(subErr.message);
        if (!subjects || subjects.length === 0) return [];

        const subjectIds = subjects.map(s => s.id);
        const { data: topics, error: topicErr } = await this.client
            .from('topics').select('id').in('materia_id', subjectIds);
        if (topicErr) throw new Error(topicErr.message);
        if (!topics || topics.length === 0) return [];

        const topicIds = topics.map(t => t.id);

        // Paso 2: obtener tareas de esos temas
        const { data, error } = await this.client
            .from('tasks')
            .select('*')
            .in('topic_id', topicIds)
            .order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return this._toDomainList(data);
    }

    // -- Mutations --------------------------------------------

    async create(taskData) {
        const payload = {
            title: taskData.title,
            description: taskData.description || '',
            topic_id: taskData.topicId,
            due_date: taskData.dueDate || null,
            time_limit_minutes: taskData.timeLimitMinutes ?? null,
        };
        const { data, error } = await this.client
            .from('tasks')
            .insert(payload)
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._toDomain(data);
    }

    async update(id, updateData) {
        const payload = {};
        if (updateData.title !== undefined) payload.title = updateData.title;
        if (updateData.description !== undefined) payload.description = updateData.description;
        if (updateData.dueDate !== undefined) payload.due_date = updateData.dueDate;
        if (updateData.timeLimitMinutes !== undefined) payload.time_limit_minutes = updateData.timeLimitMinutes;
        // No se incluyen campos inexistentes (max_score, is_active, updated_at)

        const { data, error } = await this.client
            .from('tasks')
            .update(payload)
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._toDomain(data);
    }

    async delete(id) {
        // 1. Delete RAG documents tied directly to this task
        await this.client.from('rag_documents').delete().eq('task_id', id);

        // 2. Delete RAG documents tied to content items of this task, then the content items
        const { data: items } = await this.client
            .from('content_items').select('id').eq('task_id', id);
        if (items?.length > 0) {
            await this.client.from('rag_documents').delete()
                .in('content_item_id', items.map(i => i.id));
            await this.client.from('content_items').delete().eq('task_id', id);
        }

        // 3. Delete task submissions
        await this.client.from('task_submissions').delete().eq('task_id', id);

        // 4. Delete question sessions referencing this task
        await this.client.from('question_sessions').delete().eq('task_id', id);

        // 5. Delete the task
        const { error } = await this.client.from('tasks').delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    /**
     * Cuenta las tareas de un curso (via join con topics).
     */
    async countByCourse(courseId) {
        // Paso 1: obtener IDs de temas del curso
        const { data: topics, error: topicErr } = await this.client
            .from('topics')
            .select('id')
            .eq('course_id', courseId);
        if (topicErr || !topics || topics.length === 0) return 0;

        const topicIds = topics.map(t => t.id);

        // Paso 2: contar tareas de esos temas
        const { count, error } = await this.client
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .in('topic_id', topicIds);
        return error ? 0 : count;
    }
}
export default SupabaseTaskRepository;

