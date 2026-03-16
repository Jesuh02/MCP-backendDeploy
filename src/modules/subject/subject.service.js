import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class SubjectDomainService {
    constructor({ subjectRepository, courseRepository, collaboratorRepository }) {
        this.subjectRepo = subjectRepository;
        this.courseRepo = courseRepository;
        this.collaboratorRepo = collaboratorRepository || null;
    }

    async _checkCourseAccess(userId, courseId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(userId)) return true;
        if (this.collaboratorRepo) return this.collaboratorRepo.isCollaborator(userId, courseId);
        return false;
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

    async create(data, requesterId) {
        const course = await this.courseRepo.findById(data.courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', data.courseId));
        if (requesterId) {
            const hasAccess = await this._checkCourseAccess(requesterId, data.courseId);
            if (!hasAccess) return Result.fail(new ForbiddenError('No tienes permiso para crear materias en este curso'));
            data.createdBy = requesterId;
        }
        const created = await this.subjectRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const subject = await this.subjectRepo.findById(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        if (requesterId) {
            const course = await this.courseRepo.findById(subject.course_id);
            const isCourseOwner = course && Number(course.creator_user_id) === Number(requesterId);
            if (!isCourseOwner) {
                const isSubjectCreator = subject.created_by && Number(subject.created_by) === Number(requesterId);
                if (!isSubjectCreator) return Result.fail(new ForbiddenError('No tienes permiso para editar esta materia'));
            }
            data.updatedBy = requesterId;
        }
        const updated = await this.subjectRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const subject = await this.subjectRepo.findById(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        if (requesterId) {
            const course = await this.courseRepo.findById(subject.course_id);
            const isCourseOwner = course && Number(course.creator_user_id) === Number(requesterId);
            if (!isCourseOwner) {
                const isSubjectCreator = subject.created_by && Number(subject.created_by) === Number(requesterId);
                if (!isSubjectCreator) return Result.fail(new ForbiddenError('No tienes permiso para eliminar esta materia'));
            }
        }
        await this.subjectRepo.delete(id);
        return Result.ok({ message: 'Materia eliminada' });
    }
}
export default SubjectDomainService;
