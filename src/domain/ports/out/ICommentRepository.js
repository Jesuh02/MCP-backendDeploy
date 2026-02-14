/**
 * ICommentRepository — Puerto de salida para comentarios de video.
 * @interface
 */
export class ICommentRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByVideo(videoId, options) { throw new Error('Not implemented'); }
    async create(data) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async delete(id) { throw new Error('Not implemented'); }
    async countByVideo(videoId) { throw new Error('Not implemented'); }
}
export default ICommentRepository;

