/**
 * FileContextDomainService — Manages file_contexts.
 */
import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class FileContextDomainService {
    constructor({ fileContextRepository }) {
        this.fileContextRepo = fileContextRepository;
    }

    async getById(id) {
        const fc = await this.fileContextRepo.findById(id);
        if (!fc) return Result.fail(new NotFoundError('FileContext', id));
        return Result.ok(fc);
    }

    async getBySubmission(submissionId) {
        const fcs = await this.fileContextRepo.findBySubmissionId(submissionId);
        return Result.ok(fcs);
    }

    async list(pagination = {}) {
        const fcs = await this.fileContextRepo.findAll(pagination);
        return Result.ok(fcs);
    }

    async create(data) {
        const created = await this.fileContextRepo.create(data);
        return Result.ok(created);
    }

    async delete(id) {
        const fc = await this.fileContextRepo.findById(id);
        if (!fc) return Result.fail(new NotFoundError('FileContext', id));
        await this.fileContextRepo.delete(id);
        return Result.ok({ message: 'FileContext eliminado' });
    }
}
export default FileContextDomainService;

