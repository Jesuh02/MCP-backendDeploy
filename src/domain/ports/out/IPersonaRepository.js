/**
 * IPersonaRepository — Puerto de salida para persistencia de personas.
 * @interface
 */
export class IPersonaRepository {
    async findAll() { throw new Error('Not implemented'); }
    async findById(id) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
}
export default IPersonaRepository;

