export class ProgressController {
    constructor({ progressService }) {
        this.progressService = progressService;
    }

    getMyProgress = async(req, res, next) => {
        try {
            const result = await this.progressService.getByUser(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    getByCourse = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.progressService.getByUserAndCourse(req.user.userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getLeaderboard = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const limit = parseInt(req.query.limit) || 10;
            const result = await this.progressService.getLeaderboard(courseId, limit);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    upsert = async(req, res, next) => {
        try {
            const data = {...req.body, userId: req.user.userId };
            const result = await this.progressService.upsert(data);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getEnrolledCount = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.progressService.getEnrolledCount(courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    isEnrolled = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.progressService.isEnrolled(req.user.userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getEnrolledCourseIds = async(req, res, next) => {
        try {
            const result = await this.progressService.getEnrolledCourseIds(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getTopStudents = async(req, res, next) => {
        try {
            const limit = parseInt(req.query.limit) || 10;
            const result = await this.progressService.getTopStudentsGlobal(limit);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    issueCertificate = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const userId = req.body.userId || req.user.userId;
            const result = await this.progressService.issueCertificate(userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    updateCertificateUrl = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const userId = req.body.userId || req.user.userId;
            const result = await this.progressService.updateCertificateUrl(userId, courseId, req.body.certificateUrl);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getAllByCourse = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.progressService.getAllByCourse(courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default ProgressController;