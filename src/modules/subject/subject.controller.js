import { createSubjectSchema, updateSubjectSchema } from './subject.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../shared/pagination.js';

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
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async (req, res, next) => {
        try {
            const result = await this.subjectService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async (req, res, next) => {
        try {
            const { error, value } = createSubjectSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.subjectService.create(value, req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    update = async (req, res, next) => {
        try {
            const { error, value } = updateSubjectSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.subjectService.update(parseInt(req.params.id), value, req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async (req, res, next) => {
        try {
            const result = await this.subjectService.delete(parseInt(req.params.id), req.user?.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default SubjectController;
