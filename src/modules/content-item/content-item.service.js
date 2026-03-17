import { Result } from '../../shared/Result.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/index.js';

export class ContentItemDomainService {
    constructor({ contentItemRepository, topicRepository, taskRepository, subjectRepository, courseRepository, collaboratorRepository }) {
        this.contentRepo = contentItemRepository;
        this.topicRepo = topicRepository;
        this.taskRepo = taskRepository || null;
        this.subjectRepo = subjectRepository || null;
        this.courseRepo = courseRepository || null;
        this.collaboratorRepo = collaboratorRepository || null;
    }

    async _getTopicByItemData(data) {
        const topicId = data.topicId || data.topic_id;
        if (topicId) return this.topicRepo.findById(topicId);

        const taskId = data.taskId || data.task_id;
        if (!taskId || !this.taskRepo) return null;

        const task = await this.taskRepo.findById(taskId);
        if (!task?.topicId) return null;
        return this.topicRepo.findById(task.topicId);
    }

    async _getSubjectByTopic(topic) {
        if (!topic || !this.subjectRepo) return null;
        const subjectId = topic.materia_id || topic.subject_id || topic.subjectId;
        if (!subjectId) return null;
        return this.subjectRepo.findById(subjectId);
    }

    async _resolveSubjectByItem(item) {
        const topic = await this._getTopicByItemData(item);
        return this._getSubjectByTopic(topic);
    }

    async _canManageSubject(requesterId, subject) {
        if (!requesterId || !subject || !this.courseRepo) return false;

        const course = await this.courseRepo.findById(subject.course_id);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(requesterId)) return true;
        if (subject.created_by && Number(subject.created_by) === Number(requesterId)) return true;

        if (!this.collaboratorRepo) return false;
        const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, subject.course_id);
        return Boolean(isCollab && !subject.created_by);
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
        const items = await this.contentRepo.findByCourse(courseId, this.topicRepo);
        return Result.ok(items);
    }

    async create(data, requesterId, currentUser = null) {
        if (requesterId) {
            const topic = await this._getTopicByItemData(data);
            const subject = await this._getSubjectByTopic(topic);
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para crear contenido en esta materia'));
            data.createdBy = requesterId;
            data.creatorUsuarioId = data.creatorUsuarioId || requesterId;
            data.creatorUsername = data.creatorUsername || currentUser?.username || null;
        }

        // Check for duplicate before inserting
        const existing = await this.contentRepo.findDuplicate(data);
        if (existing) {
            return Result.ok(existing);
        }
        const created = await this.contentRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const item = await this.contentRepo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Contenido', id));
        if (requesterId) {
            const subject = await this._resolveSubjectByItem(item);
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para editar este contenido'));
            data.updatedBy = requesterId;
        }
        const updated = await this.contentRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const item = await this.contentRepo.findById(id);
        if (!item) return Result.fail(new NotFoundError('Contenido', id));
        if (requesterId) {
            const subject = await this._resolveSubjectByItem(item);
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para eliminar este contenido'));
        }
        await this.contentRepo.delete(id);
        return Result.ok({ message: 'Contenido eliminado' });
    }

    async deleteByTask(taskId, requesterId) {
        if (requesterId && this.taskRepo) {
            const task = await this.taskRepo.findById(taskId);
            if (!task) return Result.fail(new NotFoundError('Tarea', taskId));
            const topic = task.topicId ? await this.topicRepo.findById(task.topicId) : null;
            const subject = await this._getSubjectByTopic(topic);
            const canManage = await this._canManageSubject(requesterId, subject);
            if (!canManage) return Result.fail(new ForbiddenError('No tienes permiso para eliminar este contenido'));
        }
        await this.contentRepo.deleteByTask(taskId);
        return Result.ok({ message: 'Contenidos de tarea eliminados' });
    }
}
export default ContentItemDomainService;

