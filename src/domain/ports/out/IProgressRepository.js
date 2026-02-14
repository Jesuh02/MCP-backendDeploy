/**
 * IProgressRepository — Puerto de salida para progreso de estudiante.
 * @interface
 */
export class IProgressRepository {
    async findByUserAndCourse(userId, courseId) { throw new Error('Not implemented'); }
    async findByUser(userId) { throw new Error('Not implemented'); }
    async findByCourse(courseId) { throw new Error('Not implemented'); }
    async upsert(data) { throw new Error('Not implemented'); }
    async delete(userId, courseId) { throw new Error('Not implemented'); }
    async getLeaderboard(courseId, limit) { throw new Error('Not implemented'); }
}
export default IProgressRepository;

