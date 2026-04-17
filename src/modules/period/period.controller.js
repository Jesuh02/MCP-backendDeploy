export class PeriodController {
    constructor({ periodService }) {
        this.periodService = periodService;
    }

    closePeriod = async (req, res, next) => {
        try {
            const { courseId, subjectId, name } = req.body;
            if (!courseId || !subjectId) {
                return res.status(400).json({ success: false, error: 'courseId y subjectId son requeridos' });
            }
            const result = await this.periodService.closePeriod(req.user.userId, {
                courseId: parseInt(courseId),
                subjectId: parseInt(subjectId),
                name,
            });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    startPeriod = async (req, res, next) => {
        try {
            const { courseId, subjectId, name, startsAt, endsAt } = req.body;
            if (!courseId || !subjectId) {
                return res.status(400).json({ success: false, error: 'courseId y subjectId son requeridos' });
            }
            if (!startsAt || !endsAt) {
                return res.status(400).json({ success: false, error: 'startsAt y endsAt son requeridos' });
            }
            const result = await this.periodService.startPeriod(req.user.userId, {
                courseId: parseInt(courseId),
                subjectId: parseInt(subjectId),
                name,
                startsAt,
                endsAt,
            });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    listBySubject = async (req, res, next) => {
        try {
            const result = await this.periodService.listBySubject(req.params.subjectId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    listByCourse = async (req, res, next) => {
        try {
            const result = await this.periodService.listByCourse(req.params.courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async (req, res, next) => {
        try {
            const result = await this.periodService.getById(req.params.periodId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    updateGrades = async (req, res, next) => {
        try {
            const { manualGrades, taskGrades } = req.body;
            const result = await this.periodService.updatePeriodGrades(req.params.periodId, { manualGrades, taskGrades });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    deletePeriod = async (req, res, next) => {
        try {
            const result = await this.periodService.deletePeriod(req.params.periodId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
