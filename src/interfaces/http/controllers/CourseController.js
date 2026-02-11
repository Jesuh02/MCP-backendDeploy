import { createCourseSchema, updateCourseSchema } from '../../../domain/validators/CourseSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../../shared/pagination.js';

export class CourseController {
    constructor({ courseService }) {
        this.courseService = courseService;
    }

    list = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.courseService.list(pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    getStats = async(req, res, next) => {
        try {
            const result = await this.courseService.getStats();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.courseService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCreator = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.courseService.findByCreator(req.params.username, pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };
    search = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.courseService.search(req.query.q || '', pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createCourseSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.courseService.create(value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    update = async(req, res, next) => {
        try {
            const { error, value } = updateCourseSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.courseService.update(parseInt(req.params.id), value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    delete = async(req, res, next) => {
        try {
            const result = await this.courseService.delete(parseInt(req.params.id), req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getFreeCourses = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.courseService.findFreeCourses(pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    getPremiumCourses = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.courseService.findPremiumCourses(pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    getPurchasedCourses = async(req, res, next) => {
        try {
            const userId = req.user?.userId || req.query.userId;
            if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });

            const pg = parsePagination(req.query);
            const result = await this.courseService.findPurchasedCourses(userId, pg);
            if (result.isFail()) return next(result.getError());
            
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    getEnrolledCourses = async(req, res, next) => {
        try {
            const userId = req.user?.userId || req.query.userId;
            const pg = parsePagination(req.query);
            const result = await this.courseService.findEnrolledCourses(userId, pg);
            if (result.isFail()) return next(result.getError());

            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };

    getByIds = async(req, res, next) => {
        try {
            const ids = (req.query.ids || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0);
            if (ids.length === 0) return res.json({ success: true, data: [] });
            const result = await this.courseService.findByIds(ids);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCreatorId = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.courseService.findByCreatorUserId(parseInt(req.params.userId), pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) { next(err); }
    };
}
export default CourseController;