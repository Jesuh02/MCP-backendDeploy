import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class TopicDomainService {
    constructor({ topicRepository, subjectRepository }) {
        this.topicRepo = topicRepository;
        this.subjectRepo = subjectRepository;
    }

    async list(pg) {
        const { topics, total } = await this.topicRepo.findAll(pg);
        return Result.ok({ topics, total });
    }

    async getBySubject(subjectId) {
        const topics = await this.topicRepo.findBySubject(subjectId);
        return Result.ok(topics);
    }

    async getByCourse(courseId) {
        const topics = await this.topicRepo.findByCourse(courseId);
        return Result.ok(topics);
    }

    async getById(id) {
        const topic = await this.topicRepo.findById(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        const subjectId = topic.materia_id || topic.subject_id;
        if (subjectId && this.subjectRepo) {
            const subject = await this.subjectRepo.findById(subjectId);
            if (subject?.course_id) topic.course_id = subject.course_id;
        }
        return Result.ok(topic);
    }

    async create(data) {
        const subject = await this.subjectRepo.findById(data.subjectId);
        if (!subject) return Result.fail(new NotFoundError('Materia', data.subjectId));
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

    async resolveCourseId(topicId) {
        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return null;
        const subjectId = topic.materia_id || topic.subject_id;
        if (!subjectId) return null;
        const subject = await this.subjectRepo.findById(subjectId);
        return subject?.course_id || null;
    }

    async resolveSubjectId(topicId) {
        const topic = await this.topicRepo.findById(topicId);
        if (!topic) return null;
        return topic.materia_id || topic.subject_id || null;
    }

    async deleteTopicOnly(id) {
        const topic = await this.topicRepo.findById(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        await this.topicRepo.deleteTopicOnly(id);
        return Result.ok({ message: 'Tema eliminado (tareas conservadas)' });
    }
}
export default TopicDomainService;

