/**
 * IRolRepository — Puerto de salida para persistencia de roles.
 * @interface
 */
export class IRolRepository {
    async findAll() { throw new Error('Not implemented'); }
    async findById(id) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
}
export default IRolRepository;

