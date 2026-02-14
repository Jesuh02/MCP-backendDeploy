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
            // Normalize: accept both camelCase and snake_case from clients
            if (!data.courseId && data.curso_id) data.courseId = data.curso_id;
            if (!data.courseId && data.cursoId) data.courseId = data.cursoId;
            if (!data.userId && data.usuario_estudiante) data.userId = data.usuario_estudiante;
            if (!data.userId && data.usuarioEstudiante) data.userId = data.usuarioEstudiante;

            // Normalize progress metrics from Spanish/camel/snake variants
            if (data.completedTasks === undefined || data.completedTasks === null) {
                if (data.tareasCompletadas !== undefined) data.completedTasks = data.tareasCompletadas;
                else if (data.tareas_completadas !== undefined) data.completedTasks = data.tareas_completadas;
            }
            if (data.totalTasks === undefined || data.totalTasks === null) {
                if (data.tareasTotales !== undefined) data.totalTasks = data.tareasTotales;
                else if (data.tareas_totales !== undefined) data.totalTasks = data.tareas_totales;
            }
            if (data.progressPercentage === undefined || data.progressPercentage === null) {
                if (data.porcentajeProgreso !== undefined) data.progressPercentage = data.porcentajeProgreso;
                else if (data.porcentaje_progreso !== undefined) data.progressPercentage = data.porcentaje_progreso;
            }
            if (data.averageGrade === undefined || data.averageGrade === null) {
                if (data.calificacionPonderada !== undefined) data.averageGrade = data.calificacionPonderada;
                else if (data.calificacion_ponderada !== undefined) data.averageGrade = data.calificacion_ponderada;
                else if (data.promedio !== undefined) data.averageGrade = data.promedio;
            }
            if (!data.status && data.estado) data.status = data.estado;

            // Validate required fields — ensure courseId is a positive integer
            const cid = parseInt(data.courseId);
            const uid = parseInt(data.userId);
            if (!cid || isNaN(cid) || cid <= 0) {
                return res.status(400).json({ success: false, error: 'courseId is required and must be a positive integer' });
            }
            if (!uid || isNaN(uid) || uid <= 0) {
                return res.status(400).json({ success: false, error: 'userId is required and must be a positive integer' });
            }
            data.courseId = cid;
            data.userId = uid;
            if (data.completedTasks !== undefined) {
                const completed = parseInt(data.completedTasks);
                data.completedTasks = Number.isNaN(completed) || completed < 0 ? 0 : completed;
            }
            if (data.totalTasks !== undefined) {
                const total = parseInt(data.totalTasks);
                data.totalTasks = Number.isNaN(total) || total < 0 ? 0 : total;
            }
            if (data.progressPercentage !== undefined) {
                const pct = parseFloat(data.progressPercentage);
                data.progressPercentage = Number.isNaN(pct) ? 0 : Math.max(0, Math.min(100, pct));
            }
            if (data.averageGrade !== undefined && data.averageGrade !== null) {
                const avg = parseFloat(data.averageGrade);
                data.averageGrade = Number.isNaN(avg) ? null : avg;
            }
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
            const limit = parseInt(req.query.limit) || 5;
            const result = await this.progressService.getTopStudentsGlobal(limit, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getCreatorEnrollmentAnalytics = async(req, res, next) => {
        try {
            const weeklyDays = parseInt(req.query.weeklyDays) || 7;
            const monthlyMonths = parseInt(req.query.monthlyMonths) || 6;
            const result = await this.progressService.getCreatorEnrollmentAnalytics(req.user.userId, {
                weeklyDays,
                monthlyMonths,
            });
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

    recalculate = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            if (!courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }
            const result = await this.progressService.recalculateForCourse(courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default ProgressController;