import { Task } from '../../../domain/entities/Task.js';

/**
 * SupabaseTaskRepository — Adaptador de salida (infraestructura).
 *
 * Implementa ITaskRepository usando el cliente de Supabase.
 * Responsabilidades:
 *   1. Ejecutar queries contra la tabla `tasks`.
 *   2. Mapear filas snake_case a entidades de dominio camelCase via Task.fromSupabaseRow().
 *   3. Mapear datos de dominio camelCase a snake_case para inserts / updates.
 *
 * Tabla `tasks` (columnas reales):
 *   id | topic_id | title | description | due_date | created_at
 *
 * Nota: NO existe `course_id` en `tasks`; la relación con cursos va
 *       tasks.topic_id ? topics.course_id. Los métodos que necesitan filtrar
 *       por curso hacen join a través de `topics`.
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
     * Como `tasks` no tiene `course_id`, se resuelve a través de `topics`:
     *   1. Obtener los topic IDs del curso.
     *   2. Filtrar tareas por esos topic IDs.
     */
    async findByCourse(courseId) {
        // Paso 1: obtener IDs de temas del curso
        const { data: topics, error: topicErr } = await this.client
            .from('topics')
            .select('id')
            .eq('course_id', courseId);
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
        const { error } = await this.client
            .from('tasks')
            .delete()
            .eq('id', id);
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

