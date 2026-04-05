import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class SubjectDomainService {
    constructor({ subjectRepository, courseRepository, collaboratorRepository, progressRepository }) {
        this.subjectRepo = subjectRepository;
        this.courseRepo = courseRepository;
        this.collaboratorRepo = collaboratorRepository || null;
        this.progressRepo = progressRepository || null;
        this.cacheTtlMs = 60000;
        this.courseCache = new Map();
        this.subjectCache = new Map();
        this.subjectsByCourseCache = new Map();
    }

    async _canManageSubject(requesterId, subject, requesterRoles = []) {
        if (!requesterId || !subject) return false;

        // Role 3 (admin) can manage any subject regardless of creator
        if (Array.isArray(requesterRoles) && requesterRoles.map(Number).includes(3)) return true;

        const course = await this.courseRepo.findById(subject.course_id);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(requesterId)) return true;
        if (subject.created_by && Number(subject.created_by) === Number(requesterId)) return true;

        if (!this.collaboratorRepo) return false;
        const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, subject.course_id);
        return Boolean(isCollab && !subject.created_by);
    }

    async _remember(cache, key, loader) {
        const now = Date.now();
        const entry = cache.get(key);
        if (entry && entry.expiresAt > now) return entry.value;
        const value = await loader();
        cache.set(key, { value, expiresAt: now + this.cacheTtlMs });
        return value;
    }

    _invalidateCourse(courseId) {
        if (!courseId) return;
        this.courseCache.delete(courseId);
        this.subjectsByCourseCache.delete(courseId);
    }

    _invalidateSubject(subjectId, courseId) {
        if (subjectId) this.subjectCache.delete(subjectId);
        this._invalidateCourse(courseId);
    }

    async _getCourse(courseId) {
        if (!courseId) return null;
        return this._remember(this.courseCache, courseId, () => this.courseRepo.findById(courseId));
    }

    async _getSubject(subjectId) {
        if (!subjectId) return null;
        return this._remember(this.subjectCache, subjectId, () => this.subjectRepo.findById(subjectId));
    }

    async _getSubjectsByCourse(courseId) {
        if (!courseId) return [];
        return this._remember(this.subjectsByCourseCache, courseId, () => this.subjectRepo.findByCourse(courseId));
    }

    async _checkCourseAccess(userId, courseId) {
        const course = await this._getCourse(courseId);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(userId)) return true;
        if (this.collaboratorRepo) return this.collaboratorRepo.isCollaborator(userId, courseId);
        return false;
    }

    async list(pg) {
        const { subjects, total } = await this.subjectRepo.findAll(pg);
        return Result.ok({ subjects, total });
    }

    async getByCourse(courseId, requesterId) {
        const subjects = await this._getSubjectsByCourse(courseId);
        let result = subjects;
        if (requesterId) {
            const course = await this._getCourse(courseId);
            const isCourseOwner = course && Number(course.creator_user_id) === Number(requesterId);
            if (!isCourseOwner) {
                const isCollab = this.collaboratorRepo && await this.collaboratorRepo.isCollaborator(requesterId, courseId);
                if (isCollab) {
                    result = subjects.filter(s => s.created_by && Number(s.created_by) === Number(requesterId));
                    return Result.ok(result);
                }
            }
            // Annotate per-user blocks via subject_access_blocks
            if (this.progressRepo) {
                const blocks = await this.progressRepo.findSubjectAccessBlocksByUserAndCourse(requesterId, courseId);
                if (blocks.length) {
                    const blockedMap = new Map(blocks.map(b => [Number(b.subject_id), b.reason || null]));
                    result = result.map(s => blockedMap.has(s.id)
                        ? { ...s, blocked: true, blockReason: blockedMap.get(s.id) }
                        : s
                    );
                }
            }
        }
        return Result.ok(result);
    }

    async getById(id) {
        const subject = await this._getSubject(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        return Result.ok(subject);
    }

    async create(data, requesterId) {
        const course = await this._getCourse(data.courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', data.courseId));
        if (requesterId) {
            const hasAccess = await this._checkCourseAccess(requesterId, data.courseId);
            if (!hasAccess) return Result.fail(new ForbiddenError('No tienes permiso para crear materias en este curso'));
            data.createdBy = requesterId;
        }
        const created = await this.subjectRepo.create(data);
        this._invalidateSubject(created?.id, data.courseId);
        return Result.ok(created);
    }

    async update(id, data, requesterId, requesterRoles = []) {
        const subject = await this._getSubject(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject, requesterRoles);
            if (!canManage) {
                return Result.fail(new ForbiddenError('No tienes permiso para editar esta materia'));
            }
            data.updatedBy = requesterId;
        }
        const updated = await this.subjectRepo.update(id, data);
        this._invalidateSubject(id, subject.course_id);
        return Result.ok(updated);
    }

    async delete(id, requesterId, requesterRoles = []) {
        const subject = await this._getSubject(id);
        if (!subject) return Result.fail(new NotFoundError('Materia', id));
        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject, requesterRoles);
            if (!canManage) {
                return Result.fail(new ForbiddenError('No tienes permiso para eliminar esta materia'));
            }
        }
        await this.subjectRepo.delete(id);
        this._invalidateSubject(id, subject.course_id);
        return Result.ok({ message: 'Materia eliminada', courseId: subject.course_id });
    }
}
export default SubjectDomainService;
