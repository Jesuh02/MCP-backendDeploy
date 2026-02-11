import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

/**
 * TaskDomainService — Servicio de dominio (casos de uso) para Tareas.
 *
 * Orquesta la lógica de negocio usando puertos inyectados:
 *   - taskRepository  (ITaskRepository)
 *   - topicRepository (ITopicRepository) — para validar existencia de temas
 *
 * No conoce detalles de infraestructura (Supabase, HTTP, etc.).
 */
export class TaskDomainService {
    /**
     * @param {object} deps
     * @param {import('../../domain/ports/out/ITaskRepository.js').ITaskRepository} deps.taskRepository
     * @param {import('../../domain/ports/out/ITopicRepository.js').ITopicRepository} deps.topicRepository
     */
    constructor({ taskRepository, topicRepository }) {
        this.taskRepo = taskRepository;
        this.topicRepo = topicRepository;
    }

    /** Lista paginada de tareas. */
    async list(pg) {
        const { tasks, total } = await this.taskRepo.findAll(pg);
        return Result.ok({ tasks, total });
    }

    /** Obtiene una tarea por ID. */
    async getById(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        return Result.ok(task);
    }

    /** Obtiene todas las tareas de un tema. */
    async getByTopic(topicId) {
        // Validar que el tema exista
        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return Result.fail(new NotFoundError('Tema', topicId));
        const tasks = await this.taskRepo.findByTopic(topicId);
        return Result.ok(tasks);
    }

    /** Obtiene todas las tareas de un curso (via topics). */
    async getByCourse(courseId) {
        const tasks = await this.taskRepo.findByCourse(courseId);
        return Result.ok(tasks);
    }

    /** Crea una nueva tarea, validando que el tema exista. */
    async create(data) {
        if (data.topicId) {
            const topic = await this.topicRepo.findById(data.topicId);
            if (!topic) return Result.fail(new NotFoundError('Tema', data.topicId));
        }
        const created = await this.taskRepo.create(data);
        return Result.ok(created);
    }

    /** Actualiza una tarea existente. */
    async update(id, data) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        const updated = await this.taskRepo.update(id, data);
        return Result.ok(updated);
    }

    /** Elimina una tarea por ID. */
    async delete(id) {
        const task = await this.taskRepo.findById(id);
        if (!task) return Result.fail(new NotFoundError('Tarea', id));
        await this.taskRepo.delete(id);
        return Result.ok({ message: 'Tarea eliminada' });
    }
}
export default TaskDomainService;