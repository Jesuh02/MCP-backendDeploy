/**
 * IFileContextRepository — Puerto de salida para persistencia de contextos de archivos.
 * @interface
 */
export class IFileContextRepository {
    async findBySubmissionId(submissionId) { throw new Error('Not implemented'); }
    async findById(id) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async findByFileUri(fileUri) { throw new Error('Not implemented'); }
}
export default IFileContextRepository;

