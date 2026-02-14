/**
 * IContentItemRepository — Puerto de salida para content items.
 * @interface
 */
export class IContentItemRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByTask(taskId) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async deleteByTask(taskId) { throw new Error('Not implemented'); }
}
export default IContentItemRepository;

