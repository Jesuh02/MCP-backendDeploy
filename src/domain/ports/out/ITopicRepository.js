/**
 * ITopicRepository — Puerto de salida para persistencia de topics.
 * @interface
 */
export class ITopicRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByCourse(courseId) { throw new Error('Not implemented'); }
    async create(topicData) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
}
export default ITopicRepository;

