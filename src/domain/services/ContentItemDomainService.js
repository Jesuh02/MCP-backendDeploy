import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class ContentItemDomainService {
    constructor({ contentItemRepository }) {
        this.contentRepo = contentItemRepository;
    }

    async getById(id) {
        const item = await this.contentRepo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Contenido', id));
        return Result.ok(item);
    }

    async getByTask(taskId) {
        const items = await this.contentRepo.findByTask(taskId);
        return Result.ok(items);
    }

    async getByTopic(topicId) {
        const items = await this.contentRepo.findByTopic(topicId);
        return Result.ok(items);
    }

    async getByCourse(courseId) {
        const items = await this.contentRepo.findByCourse(courseId);
        return Result.ok(items);
    }

    async create(data) {
        const created = await this.contentRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data) {
        const item = await this.contentRepo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Contenido', id));
        const updated = await this.contentRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const item = await this.contentRepo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Contenido', id));
        await this.contentRepo.delete(id);
        return Result.ok({ message: 'Contenido eliminado' });
    }

    async deleteByTask(taskId) {
        await this.contentRepo.deleteByTask(taskId);
        return Result.ok({ message: 'Contenidos de tarea eliminados' });
    }
}
export default ContentItemDomainService;

