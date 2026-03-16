import { createCourseSchema, updateCourseSchema } from './course.schemas.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../shared/pagination.js';

export class CourseController {
    constructor({ courseService }) {
        this.courseService = courseService;
    }

    parsePositiveInteger(value, fieldName = 'id') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new ValidationError(`${fieldName} debe ser un entero positivo`);
        }
        return parsed;
    }

    list = async(req, res, next) => {
        const pg = parsePagination(req.query);
        if (req.query.excludeUserId) pg.excludeCreatorId = parseInt(req.query.excludeUserId);
        const result = await this.courseService.list(pg);
        if (result.isFail()) return next(result.getError());
        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    getStats = async(req, res, next) => {
        const result = await this.courseService.getStats();
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };

    getFilterCounts = async(req, res, next) => {
        const userId = req.query.userId ? parseInt(req.query.userId) : (req.user?.userId || null);
        const result = await this.courseService.getFilterCounts(userId);
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };

    getMyCreatorMetrics = async(req, res, next) => {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const result = await this.courseService.getCreatorDashboardMetrics(userId);
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };

    getById = async(req, res, next) => {
        let courseId;
        try {
            courseId = this.parsePositiveInteger(req.params.id, 'courseId');
        } catch (error) {
            return next(error);
        }

        const result = await this.courseService.getById(courseId);
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };

    getByCreator = async(req, res, next) => {
        const pg = parsePagination(req.query);
        const result = await this.courseService.findByCreator(req.params.username, pg);
        if (result.isFail()) return next(result.getError());
        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };
    search = async(req, res, next) => {
        const pg = parsePagination(req.query);
        const result = await this.courseService.search(req.query.q || '', pg);
        if (result.isFail()) return next(result.getError());
        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    create = async(req, res, next) => {
        const { error, value } = createCourseSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        const result = await this.courseService.create(value, req.user.userId, req.user.roles || []);
        if (result.isFail()) return next(result.getError());
        res.status(201).json({ success: true, data: result.getValue() });
    };
    update = async(req, res, next) => {
        const { error, value } = updateCourseSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        const result = await this.courseService.update(parseInt(req.params.id), value, req.user.userId, req.user.roles || []);
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };
    delete = async(req, res, next) => {
        const result = await this.courseService.delete(parseInt(req.params.id), req.user.userId, req.user.roles || []);
        if (result.isFail()) {
            const error = result.getError();
            // Idempotencia: Si el curso no existe, consideramos que ya fue eliminado (Clean Code)
            if (error instanceof NotFoundError) {
                return res.json({ success: true, message: 'Curso eliminado (idempotente)' });
            }
            return next(error);
        }
        res.json({ success: true, data: result.getValue() });
    };

    getFreeCourses = async(req, res, next) => {
        const pg = parsePagination(req.query);
        if (req.query.excludeUserId) pg.excludeCreatorId = parseInt(req.query.excludeUserId);
        const result = await this.courseService.findFreeCourses(pg);
        if (result.isFail()) return next(result.getError());
        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    getPremiumCourses = async(req, res, next) => {
        const pg = parsePagination(req.query);
        if (req.query.excludeUserId) pg.excludeCreatorId = parseInt(req.query.excludeUserId);
        const result = await this.courseService.findPremiumCourses(pg);
        if (result.isFail()) return next(result.getError());
        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    getPopularCourses = async(req, res, next) => {
        const pg = parsePagination(req.query);
        if (req.query.excludeUserId) pg.excludeCreatorId = parseInt(req.query.excludeUserId);

        const result = await this.courseService.findPopularCourses(pg);
        if (result.isFail()) return next(result.getError());

        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    getPurchasedCourses = async(req, res, next) => {
        const userId = req.user?.userId || req.query.userId;
        if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });

        const pg = parsePagination(req.query);
        const result = await this.courseService.findPurchasedCourses(userId, pg);
        if (result.isFail()) return next(result.getError());

        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    getEnrolledCourses = async(req, res, next) => {
        const userId = req.user?.userId || req.query.userId;
        if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });

        const pg = parsePagination(req.query);
        const result = await this.courseService.findEnrolledCourses(userId, pg);
        if (result.isFail()) return next(result.getError());

        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    getByIds = async(req, res, next) => {
        const ids = (req.query.ids || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) return res.json({ success: true, data: [] });
        const result = await this.courseService.findByIds(ids);
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };

    getByCreatorId = async(req, res, next) => {
        const pg = parsePagination(req.query);
        const result = await this.courseService.findByCreatorUserId(parseInt(req.params.userId), pg);
        if (result.isFail()) return next(result.getError());
        const { courses, total } = result.getValue();
        res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
    };

    /**
     * GET /creator-id/:userId/with-submissions
     * Courses created by a user that have at least one task submission.
     */
    getCreatorCoursesWithSubmissions = async(req, res, next) => {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const result = await this.courseService.findCreatorCoursesWithSubmissions(userId);
        if (result.isFail()) return next(result.getError());
        res.json({ success: true, data: result.getValue() });
    };
}
export default CourseController;