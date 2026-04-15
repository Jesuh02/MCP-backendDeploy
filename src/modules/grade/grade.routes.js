import { Router } from 'express';

export function gradeRoutes({ gradeController, requireRoles }) {
    const router = Router();

    // Docente/Admin: set a single grade
    router.post('/', requireRoles(2, 3, 4), gradeController.setGrade);

    // Docente/Admin: bulk set grades (array of {studentId, grade})
    router.post('/bulk', requireRoles(2, 3, 4), gradeController.bulkSetGrades);

    // Docente/Admin: set same grade for all students
    router.post('/set-all', requireRoles(2, 3, 4), gradeController.setGradeForAll);

    // Docente/Admin: get all grades for a subject
    router.get('/subject/:subjectId', requireRoles(2, 3, 4), gradeController.getBySubject);

    // Docente/Admin: get full grade sheet (Excel-like) for a subject
    router.get('/sheet/:subjectId', requireRoles(2, 3, 4), gradeController.getGradeSheet);

    // Student: get own grades for a subject
    router.get('/my/subject/:subjectId', gradeController.getStudentGrades);

    // Student: get own grades for a course
    router.get('/my/course/:courseId', gradeController.getStudentCourseGrades);

    // Student: get own grade averages for a subject
    router.get('/my/subject/:subjectId/averages', gradeController.getGradeAverages);

    return router;
}

export default gradeRoutes;
