/**
 * ITaskRepository — Puerto de salida para persistencia de tareas.
 * @interface
 */
export class ITaskRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByTopic(topicId) { throw new Error('Not implemented'); }
    async findByCourse(courseId) { throw new Error('Not implemented'); }
    async create(taskData) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async countByCourse(courseId) { throw new Error('Not implemented'); }
}
export default ITaskRepository;