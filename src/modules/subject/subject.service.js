import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class SubjectDomainService {
    constructor({ subjectRepository, courseRepository }) {
        this.subjectRepo = subjectRepository;
        this.courseRepo = courseRepository;
    }

    async list(pg) {
        const { subjects, total } = await this.subjectRepo.findAll(pg);
        return Result.ok({ subjects, total });
    }

    async getByCourse(courseId) {
        const subjects = await this.subjectRepo.findByCourse(courseId);
        return Result.ok(subjects);
    }

    async getById(id) {
        const subject = await this.subjectRepo.findById(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        return Result.ok(subject);
    }

    async create(data) {
        const course = await this.courseRepo.findById(data.courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', data.courseId));
        const created = await this.subjectRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data) {
        const subject = await this.subjectRepo.findById(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        const updated = await this.subjectRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const subject = await this.subjectRepo.findById(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        await this.subjectRepo.delete(id);
        return Result.ok({ message: 'Materia eliminada' });
    }
}
export default SubjectDomainService;
