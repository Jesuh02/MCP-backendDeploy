export class ProgressController {
    constructor({ progressService }) {
        this.progressService = progressService;
    }

    getMyCertificates = async(req, res, next) => {
        try {
            const result = await this.progressService.getMyCertificates(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

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

    getSubjectProgress = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.progressService.getSubjectProgress(req.user.userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getBySubject = async(req, res, next) => {
        try {
            const subjectId = parseInt(req.params.subjectId);
            const result = await this.progressService.getByUserAndSubject(req.user.userId, subjectId);
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
            if (!data.courseId && data.curso_id) data.courseId = data.curso_id;
            if (!data.courseId && data.cursoId) data.courseId = data.cursoId;
            if (!data.userId && data.usuario_estudiante) data.userId = data.usuario_estudiante;
            if (!data.userId && data.usuarioEstudiante) data.userId = data.usuarioEstudiante;
            if (!data.subjectId && data.materia_id) data.subjectId = data.materia_id;
            if (!data.subjectId && data.materiaId) data.subjectId = data.materiaId;

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
            if (data.subjectId) {
                const sid = parseInt(data.subjectId);
                data.subjectId = Number.isNaN(sid) || sid <= 0 ? null : sid;
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
            const parsedLimit = Number.parseInt(req.query.limit, 10);
            const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;
            const result = await this.progressService.getTopStudentsByCreator(req.user.userId, limit);
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
    getCreatorCertificates = async(req, res, next) => {
        try {
            const result = await this.progressService.getCreatorCertificates(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    bulkIssueCertificates = async(req, res, next) => {
        try {
            const result = await this.progressService.bulkIssueCertificatesForCreator(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getAllCertificates = async(req, res, next) => {
        try {
            const result = await this.progressService.getAllWonCertificates();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    bulkIssueCertificatesAll = async(req, res, next) => {
        try {
            const result = await this.progressService.bulkIssueCertificatesGlobal();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    // ─── Enrollment request / approval ────────────────────────────────────────

    requestEnrollment = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            if (!courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }
            const result = await this.progressService.requestEnrollment(req.user.userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getEnrollmentStatus = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            if (!courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }
            const result = await this.progressService.isEnrolledAndApproved(req.user.userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getPendingEnrollments = async(req, res, next) => {
        try {
            const courseId = req.query.courseId ? parseInt(req.query.courseId) : null;
            if (req.query.courseId && (!courseId || isNaN(courseId) || courseId <= 0)) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }
            const result = await this.progressService.getPendingEnrollments(courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    approveEnrollment = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const courseId = parseInt(req.params.courseId);
            if (!userId || isNaN(userId) || userId <= 0 || !courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'userId and courseId must be positive integers' });
            }
            const result = await this.progressService.approveEnrollment(userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    rejectEnrollment = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const courseId = parseInt(req.params.courseId);
            if (!userId || isNaN(userId) || userId <= 0 || !courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'userId and courseId must be positive integers' });
            }
            const result = await this.progressService.rejectEnrollment(userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getApprovedEnrollments = async(req, res, next) => {
        try {
            const result = await this.progressService.getApprovedEnrollments();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    revokeEnrollment = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const courseId = parseInt(req.params.courseId);
            if (!userId || isNaN(userId) || userId <= 0 || !courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'userId and courseId must be positive integers' });
            }
            const reason = req.body?.reason || null;
            const result = await this.progressService.revokeEnrollment(userId, courseId, reason);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    blockSubjectAccess = async(req, res, next) => {
        try {
            const { userId, courseId, subjectId, reason } = req.body || {};
            const uid = parseInt(userId);
            const cid = parseInt(courseId);
            const sid = parseInt(subjectId);
            if (!uid || !cid || !sid || isNaN(uid) || isNaN(cid) || isNaN(sid)) {
                return res.status(400).json({ success: false, error: 'userId, courseId and subjectId are required' });
            }
            if (!reason || !String(reason).trim()) {
                return res.status(400).json({ success: false, error: 'reason is required' });
            }
            const blockedBy = req.user?.userId || null;
            const result = await this.progressService.blockSubjectAccess(uid, cid, sid, reason, blockedBy);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    unblockSubjectAccess = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const subjectId = parseInt(req.params.subjectId);
            if (!userId || !subjectId || isNaN(userId) || isNaN(subjectId)) {
                return res.status(400).json({ success: false, error: 'userId and subjectId must be positive integers' });
            }
            const result = await this.progressService.unblockSubjectAccess(userId, subjectId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    checkSubjectAccessBlock = async(req, res, next) => {
        try {
            const subjectId = parseInt(req.params.subjectId);
            if (!subjectId || isNaN(subjectId)) {
                return res.status(400).json({ success: false, error: 'subjectId must be a positive integer' });
            }
            const userId = req.user?.userId;
            const result = await this.progressService.checkSubjectAccessBlock(userId, subjectId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getSubjectAccessBlocks = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            if (!courseId || isNaN(courseId)) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }
            const userId = req.user?.userId;
            const result = await this.progressService.getSubjectAccessBlocks(userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default ProgressController;