/**
 * IProgressRepository — Puerto de salida para progreso de estudiante.
 * @interface
 */
export class IProgressRepository {
    async findByUserAndCourse(userId, courseId) { throw new Error('Not implemented'); }
    async findByUser(userId) { throw new Error('Not implemented'); }
    async findByCourse(courseId) { throw new Error('Not implemented'); }
    async findByCourseIds(courseIds) { throw new Error('Not implemented'); }
    async upsert(data) { throw new Error('Not implemented'); }
    async delete(userId, courseId) { throw new Error('Not implemented'); }
    async getLeaderboard(courseId, limit) { throw new Error('Not implemented'); }
    async countByCourse(courseId) { throw new Error('Not implemented'); }
    async isEnrolled(userId, courseId) { throw new Error('Not implemented'); }
    async findEnrolledCourseIds(userId) { throw new Error('Not implemented'); }

    /**
     * Obtiene registros de progreso con estado 'Ganado' para los cursos indicados.
     * @param {number[]} courseIds  IDs de los cursos a consultar.
     * @returns {Promise<Array<{userId:number, courseId:number, grade:number}>>}
     */
    async findWonProgressByCourseIds(courseIds) { throw new Error('Not implemented'); }
}
export default IProgressRepository;

