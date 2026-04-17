export class GradeController {
    constructor({ gradeService }) {
        this.gradeService = gradeService;
    }

    setGrade = async (req, res, next) => {
        try {
            const { studentId, courseId, subjectId, gradeType, grade } = req.body;
            if (!studentId || !courseId || !subjectId || !gradeType || grade === undefined) {
                return res.status(400).json({ success: false, error: 'studentId, courseId, subjectId, gradeType y grade son requeridos' });
            }
            const result = await this.gradeService.setGrade(req.user.userId, {
                studentId: parseInt(studentId),
                courseId: parseInt(courseId),
                subjectId: parseInt(subjectId),
                gradeType,
                grade: parseFloat(grade),
            });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    bulkSetGrades = async (req, res, next) => {
        try {
            const { courseId, subjectId, gradeType, entries } = req.body;
            if (!courseId || !subjectId || !gradeType || !Array.isArray(entries)) {
                return res.status(400).json({ success: false, error: 'courseId, subjectId, gradeType y entries[] son requeridos' });
            }
            const result = await this.gradeService.bulkSetGrades(req.user.userId, {
                courseId: parseInt(courseId),
                subjectId: parseInt(subjectId),
                gradeType,
                entries,
            });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    setGradeForAll = async (req, res, next) => {
        try {
            const { courseId, subjectId, gradeType, grade, studentIds } = req.body;
            if (!courseId || !subjectId || !gradeType || grade === undefined || !Array.isArray(studentIds)) {
                return res.status(400).json({ success: false, error: 'courseId, subjectId, gradeType, grade y studentIds[] son requeridos' });
            }
            const result = await this.gradeService.setGradeForAll(req.user.userId, {
                courseId: parseInt(courseId),
                subjectId: parseInt(subjectId),
                gradeType,
                grade: parseFloat(grade),
                studentIds,
            });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getBySubject = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.subjectId);
            const gradeType = req.query.type || null;
            const result = gradeType
                ? await this.gradeService.getGradesBySubjectAndType(req.user.userId, subjectId, gradeType)
                : await this.gradeService.getGradesBySubject(req.user.userId, subjectId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getStudentGrades = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.subjectId);
            const userId = req.user.userId;
            const result = await this.gradeService.getStudentGrades(userId, subjectId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getStudentCourseGrades = async (req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const userId = req.user.userId;
            const result = await this.gradeService.getStudentCourseGrades(userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getGradeAverages = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.subjectId);
            const userId = req.user.userId;
            const result = await this.gradeService.getGradeAverages(userId, subjectId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getGradeSheet = async (req, res, next) => {
        try {
            const subjectId = parseInt(req.params.subjectId);
            if (!Number.isInteger(subjectId) || subjectId <= 0) {
                return res.status(400).json({ success: false, error: 'subjectId inválido' });
            }
            const result = await this.gradeService.getGradeSheet(req.user.userId, subjectId, req.user.roles);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}

export default GradeController;
