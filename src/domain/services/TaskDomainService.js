import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class TaskDomainService {
    constructor({ taskRepository, topicRepository }) {
        this.taskRepo = taskRepository;
        this.topicRepo = topicRepository;
    }

    async getById(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        return Result.ok(task);
    }

    async getByTopic(topicId) {
        const tasks = await this.taskRepo.findByTopic(topicId);
        return Result.ok(tasks);
    }

    async getByCourse(courseId) {
        const tasks = await this.taskRepo.findByCourse(courseId);
        return Result.ok(tasks);
    }

    async create(data) {
        if (data.topicId) {
            const topic = await this.topicRepo.findById(data.topicId);
            if (!topic) return Result.fail(new NotFoundError('Tema', data.topicId));
        }
        const created = await this.taskRepo.create(data);
        return Result.ok(created);
    }
    async update(id, data) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        const updated = await this.taskRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        await this.taskRepo.delete(id);
        return Result.ok({ message: 'Tarea eliminada' });
    }
}
export default TaskDomainService;