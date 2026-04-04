import { Result } from '../../shared/Result.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/index.js';

export class TopicDomainService {
    constructor({ topicRepository, subjectRepository, courseRepository, collaboratorRepository }) {
        this.topicRepo = topicRepository;
        this.subjectRepo = subjectRepository;
        this.courseRepo = courseRepository;
        this.collaboratorRepo = collaboratorRepository || null;
        this.cacheTtlMs = 60000;
        this.subjectCache = new Map();
        this.topicCache = new Map();
        this.topicsByCourseCache = new Map();
        this.topicsBySubjectCache = new Map();
    }

    async _remember(cache, key, loader) {
        const now = Date.now();
        const entry = cache.get(key);
        if (entry && entry.expiresAt > now) return entry.value;
        const value = await loader();
        cache.set(key, { value, expiresAt: now + this.cacheTtlMs });
        return value;
    }

    async _getSubject(subjectId) {
        if (!subjectId || !this.subjectRepo) return null;
        return this._remember(this.subjectCache, subjectId, () => this.subjectRepo.findById(subjectId));
    }

    async _getSubjectByTopic(topic) {
        if (!topic) return null;
        const subjectId = topic.materia_id || topic.subject_id || topic.subjectId;
        return this._getSubject(subjectId);
    }

    async _getTopic(topicId) {
        if (!topicId) return null;
        return this._remember(this.topicCache, topicId, () => this.topicRepo.findById(topicId));
    }

    async _getTopicsBySubject(subjectId) {
        if (!subjectId) return [];
        return this._remember(this.topicsBySubjectCache, subjectId, () => this.topicRepo.findBySubject(subjectId));
    }

    async _getTopicsByCourse(courseId) {
        if (!courseId) return [];
        return this._remember(this.topicsByCourseCache, courseId, () => this.topicRepo.findByCourse(courseId));
    }

    _invalidateTopic(topicId, subjectId, courseId) {
        if (topicId) this.topicCache.delete(topicId);
        if (subjectId) {
            this.subjectCache.delete(subjectId);
            this.topicsBySubjectCache.delete(subjectId);
        }
        if (courseId) this.topicsByCourseCache.delete(courseId);
    }

    async _canManageSubject(requesterId, subject) {
        if (!requesterId || !subject) return false;

        const course = await this.courseRepo.findById(subject.course_id);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(requesterId)) return true;
        if (subject.created_by && Number(subject.created_by) === Number(requesterId)) return true;

        if (!this.collaboratorRepo) return false;
        const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, subject.course_id);
        return Boolean(isCollab);
    }

    async list(pg) {
        const { topics, total } = await this.topicRepo.findAll(pg);
        return Result.ok({ topics, total });
    }

    async getBySubject(subjectId) {
        const topics = await this._getTopicsBySubject(subjectId);
        return Result.ok(topics);
    }

    async getByCourse(courseId) {
        const topics = await this._getTopicsByCourse(courseId);
        return Result.ok(topics);
    }

    async getById(id) {
        const topic = await this._getTopic(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        const subjectId = topic.materia_id || topic.subject_id || topic.subjectId;
        if (subjectId && this.subjectRepo) {
            const subject = await this._getSubject(subjectId);
            if (subject?.course_id) {
                return Result.ok({ ...topic, course_id: subject.course_id });
            }
        }
        return Result.ok(topic);
    }

    async create(data, requesterId) {
        const subject = await this._getSubject(data.subjectId);
        if (!subject) return Result.fail(new NotFoundError('Materia', data.subjectId));
        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para crear temas en esta materia'));
            data.createdBy = requesterId;
        }

        // Protección anti-duplicados: verificar si ya existe un tema reciente con mismo nombre y materia
        if (data.title && data.subjectId) {
            const existing = await this._getTopicsBySubject(data.subjectId);
            const duplicate = (existing || []).find(t => {
                const existingName = String(t.name || t.title || '').trim().toLowerCase();
                const newName = String(data.title).trim().toLowerCase();
                if (existingName !== newName) return false;
                const createdAt = new Date(t.created_at || t.createdAt);
                return (Date.now() - createdAt.getTime()) < 60000; // creado hace menos de 60 segundos
            });
            if (duplicate) {
                console.log(`[TopicDomainService] Duplicate topic blocked: "${data.title}" in subject ${data.subjectId}`);
                return Result.ok(duplicate);
            }
        }

        const created = await this.topicRepo.create(data);
        this._invalidateTopic(created?.id, data.subjectId, subject.course_id);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const topic = await this._getTopic(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        const subject = await this._getSubjectByTopic(topic);
        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para editar este tema'));
            data.updatedBy = requesterId;
        }
        const updated = await this.topicRepo.update(id, data);
        this._invalidateTopic(id, topic.materia_id || topic.subject_id || topic.subjectId, subject?.course_id);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const topic = await this._getTopic(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        const subject = await this._getSubjectByTopic(topic);
        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para eliminar este tema'));
        }
        await this.topicRepo.delete(id);
        this._invalidateTopic(id, topic.materia_id || topic.subject_id || topic.subjectId, subject?.course_id);
        return Result.ok({ message: 'Tema eliminado' });
    }

    async resolveCourseId(topicId) {
        const topic = await this._getTopic(topicId);
        if (!topic) return null;
        const subjectId = topic.materia_id || topic.subject_id || topic.subjectId;
        if (!subjectId) return null;
        const subject = await this._getSubject(subjectId);
        return subject?.course_id || null;
    }

    async resolveSubjectId(topicId) {
        const topic = await this._getTopic(topicId);
        if (!topic) return null;
        return topic.materia_id || topic.subject_id || topic.subjectId || null;
    }

    async deleteTopicOnly(id, requesterId) {
        const topic = await this._getTopic(id);
        if (!topic) return Result.fail(new NotFoundError('Tema', id));
        const subject = await this._getSubjectByTopic(topic);
        if (requesterId) {
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para eliminar este tema'));
        }
        await this.topicRepo.deleteTopicOnly(id);
        this._invalidateTopic(id, topic.materia_id || topic.subject_id || topic.subjectId, subject?.course_id);
        return Result.ok({ message: 'Tema eliminado (tareas conservadas)' });
    }
}
export default TopicDomainService;

