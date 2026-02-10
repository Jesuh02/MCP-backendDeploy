/**
 * ISubmissionRepository — Puerto de salida para entregas.
 * @interface
 */
export class ISubmissionRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByTask(taskId, options) { throw new Error('Not implemented'); }
    async findByUser(userId, options) { throw new Error('Not implemented'); }
    async findByUserAndTask(userId, taskId) { throw new Error('Not implemented'); }
    async findByCourse(courseId) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async countByUserAndCourse(userId, courseId) { throw new Error('Not implemented'); }
    async getGradedByUserAndCourse(userId, courseId) { throw new Error('Not implemented'); }
}
export default ISubmissionRepository;