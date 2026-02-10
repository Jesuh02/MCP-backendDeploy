import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class TopicDomainService {
    constructor({ topicRepository, courseRepository }) {
        this.topicRepo = topicRepository;
        this.courseRepo = courseRepository;
    }

    async list(pg) {
        const { topics, total } = await this.topicRepo.findAll(pg);
        return Result.ok({ topics, total });
    }

    async getByCourse(courseId) {
        const topics = await this.topicRepo.findByCourse(courseId);
        return Result.ok(topics);
    }

    async getById(id) {
        const topic = await this.topicRepo.findById(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        return Result.ok(topic);
    }

    async create(data) {
        const course = await this.courseRepo.findById(data.courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', data.courseId));
        const created = await this.topicRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data) {
        const topic = await this.topicRepo.findById(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        const updated = await this.topicRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const topic = await this.topicRepo.findById(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        await this.topicRepo.delete(id);
        return Result.ok({ message: 'Tema eliminado' });
    }
}
export default TopicDomainService;