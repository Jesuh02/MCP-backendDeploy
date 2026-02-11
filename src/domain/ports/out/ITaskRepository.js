/**
 * ITaskRepository — Puerto de salida para persistencia de tareas.
 *
 * Define el contrato que debe cumplir cualquier adaptador de persistencia
 * (Supabase, PostgreSQL, MongoDB, etc.) para operaciones sobre tareas.
 *
 * Todas las respuestas deben devolver entidades de dominio (camelCase),
 * nunca filas crudas de la base de datos.
 *
 * @interface
 */
export class ITaskRepository {
    /** Lista paginada de todas las tareas. */
    async findAll(pg) { throw new Error('Not implemented'); }
    /** Busca una tarea por su ID. Devuelve null si no existe. */
    async findById(id) { throw new Error('Not implemented'); }
    /** Devuelve todas las tareas asociadas a un tema (topic). */
    async findByTopic(topicId) { throw new Error('Not implemented'); }
    /**
     * Devuelve todas las tareas de un curso.
     * Nota: la tabla `tasks` no tiene `course_id`; la implementación
     * debe hacer join con `topics` para resolver la relación.
     */
    async findByCourse(courseId) { throw new Error('Not implemented'); }
    /** Crea una nueva tarea. */
    async create(taskData) { throw new Error('Not implemented'); }
    /** Actualiza una tarea existente. */
    async update(id, data) { throw new Error('Not implemented'); }
    /** Elimina una tarea por su ID. */
    async delete(id) { throw new Error('Not implemented'); }
    /** Cuenta las tareas de un curso (join con topics). */
    async countByCourse(courseId) { throw new Error('Not implemented'); }
}
export default ITaskRepository;