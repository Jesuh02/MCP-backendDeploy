import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository }) {
        this.courseRepo = courseRepository;
    }

    async getById(id) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        return Result.ok(course);
    }

    async list(pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findAll(pagination),
            this.courseRepo.count({}),
        ]);
        return Result.ok({ courses, total });
    }

    async getStats() {
        const total = await this.courseRepo.count({});
        return Result.ok({ total });
    }

    async findByCreator(username, pagination) {
        const courses = await this.courseRepo.findByCreator(username, pagination);
        return Result.ok(courses);
    }

    async search(query, pagination) {
        const courses = await this.courseRepo.search(query, pagination);
        return Result.ok(courses);
    }

    async create(courseData, requesterId) {
        courseData.creatorUserId = requesterId;
        const created = await this.courseRepo.create(courseData);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        if (course.creator_user_id && course.creator_user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para editar este curso'));
        }
        const updated = await this.courseRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        if (course.creator_user_id && course.creator_user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para eliminar este curso'));
        }
        await this.courseRepo.delete(id);
        return Result.ok({ message: 'Curso eliminado' });
    }

    async findByCreatorUserId(userId, pagination) {
        const courses = await this.courseRepo.findByCreatorUserId(userId, pagination);
        return Result.ok(courses);
    }

    async findByIds(ids) {
        const courses = await this.courseRepo.findByIds(ids);
        return Result.ok(courses);
    }

    async findFreeCourses(pagination) {
        const courses = await this.courseRepo.findFree(pagination);
        return Result.ok(courses);
    }
}
export default CourseDomainService;