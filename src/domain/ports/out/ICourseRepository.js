/**
 * ICourseRepository — Puerto de salida para persistencia de cursos.
 * @interface
 */
export class ICourseRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findAll(options) { throw new Error('Not implemented'); }
    async findByCreator(username, options) { throw new Error('Not implemented'); }
    async findByCreatorUserId(userId, options) { throw new Error('Not implemented'); }
    async findFree(options) { throw new Error('Not implemented'); }
    async search(query, options) { throw new Error('Not implemented'); }
    async create(courseData) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async existsByTitle(title) { throw new Error('Not implemented'); }
    async count(filters) { throw new Error('Not implemented'); }

    /**
     * Obtiene solo los IDs de cursos creados por un usuario.
     * @param {number} creatorUserId
     * @returns {Promise<number[]>}
     */
    async findCourseIdsByCreatorUserId(creatorUserId) { throw new Error('Not implemented'); }
}
export default ICourseRepository;

