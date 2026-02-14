/**
 * IVideoRepository — Puerto de salida para persistencia de videos.
 * @interface
 */
export class IVideoRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findAll(options) { throw new Error('Not implemented'); }
    async findByCreator(username, options) { throw new Error('Not implemented'); }
    async findByCourse(courseId, options) { throw new Error('Not implemented'); }
    async search(query, options) { throw new Error('Not implemented'); }
    async create(videoData) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async existsByTitleAndCourse(title, courseId) { throw new Error('Not implemented'); }
    async count(filters) { throw new Error('Not implemented'); }
}
export default IVideoRepository;

