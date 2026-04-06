import { createSubjectSchema, updateSubjectSchema } from './subject.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../shared/pagination.js';
import { getIO } from '../../config/socketServer.js';

export class SubjectController {
    constructor({ subjectService }) {
        this.subjectService = subjectService;
    }

    list = async (req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subjectService.list(pg);
            if (result.isFail()) return next(result.getError());
            const { subjects, total } = result.getValue();
            res.json(buildPaginatedResponse(subjects, total, pg.page, pg.pageSize));
        } catch (err) { next(err); }
    };

    getByCourse = async (req, res, next) => {
        try {
            const result = await this.subjectService.getByCourse(parseInt(req.params.courseId), req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.set('Cache-Control', 'no-store');
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async (req, res, next) => {
        try {
            const result = await this.subjectService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async (req, res, next) => {
        try {
            const { error, value } = createSubjectSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.subjectService.create(value, req.user?.userId);
            if (result.isFail()) return next(result.getError());
            const subject = result.getValue();
            const courseId = subject.course_id ?? value.courseId;
            if (courseId) getIO()?.to(`course:${courseId}`).emit('subject:created', subject);
            res.status(201).json({ success: true, data: subject });
        } catch (err) { next(err); }
    };

    update = async (req, res, next) => {
        try {
            const { error, value } = updateSubjectSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.subjectService.update(parseInt(req.params.id), value, req.user?.userId);
            if (result.isFail()) return next(result.getError());
            const subject = result.getValue();
            if (subject?.course_id) getIO()?.to(`course:${subject.course_id}`).emit('subject:updated', subject);
            res.json({ success: true, data: subject });
        } catch (err) { next(err); }
    };

    delete = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.id);
            const result = await this.subjectService.delete(subjectId, req.user?.userId);
            if (result.isFail()) return next(result.getError());
            const { courseId } = result.getValue();
            if (courseId) getIO()?.to(`course:${courseId}`).emit('subject:deleted', { id: subjectId, courseId });
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    // ── Subject collaborators ──────────────────────────────────────────────

    getSubjectCollaborators = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.id);
            const result = await this.subjectService.getSubjectCollaborators(subjectId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    addSubjectCollaborator = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.id);
            const userId = parseInt(req.body.userId);
            if (!userId) return next(new Error('userId requerido'));
            const result = await this.subjectService.addSubjectCollaborator(subjectId, userId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    removeSubjectCollaborator = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.id);
            const userId = parseInt(req.params.userId);
            const result = await this.subjectService.removeSubjectCollaborator(subjectId, userId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    syncSubjectCollaborators = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.id);
            const userIds = req.body.userIds || [];
            const result = await this.subjectService.syncSubjectCollaborators(subjectId, userIds, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default SubjectController;
