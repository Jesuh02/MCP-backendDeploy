import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class InstitucionDomainService {
    constructor({ institucionRepository }) {
        this.repo = institucionRepository;
    }

    async getById(id) {
        const item = await this.repo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Institucion', id));
        return Result.ok(item);
    }

    async list(pagination = {}) {
        const items = await this.repo.findAll(pagination);
        return Result.ok(items);
    }

    async search(query, options = {}) {
        const items = await this.repo.search(query, options);
        return Result.ok(items);
    }

    async create(data) {
        const created = await this.repo.create(data);
        return Result.ok(created);
    }

    async update(id, data) {
        const item = await this.repo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Institucion', id));
        const updated = await this.repo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const item = await this.repo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Institucion', id));
        await this.repo.delete(id);
        return Result.ok({ message: 'Institución eliminada' });
    }
}
export default InstitucionDomainService;
