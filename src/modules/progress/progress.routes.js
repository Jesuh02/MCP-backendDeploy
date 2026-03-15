import { Router } from 'express';

export function progressRoutes({ progressController }) {
    const router = Router();

    router.get('/my', progressController.getMyProgress);
    router.get('/my/certificates', progressController.getMyCertificates);
    router.get('/my/enrolled-course-ids', progressController.getEnrolledCourseIds);
    router.get('/top-students', progressController.getTopStudents);
    router.get('/creator/enrollment-analytics', progressController.getCreatorEnrollmentAnalytics);
    router.get('/course/:courseId', progressController.getByCourse);
    router.get('/course/:courseId/subjects', progressController.getSubjectProgress);
    router.get('/course/:courseId/all', progressController.getAllByCourse);
    router.get('/course/:courseId/enrolled-count', progressController.getEnrolledCount);
    router.get('/course/:courseId/enrolled', progressController.isEnrolled);
    router.get('/leaderboard/:courseId', progressController.getLeaderboard);
    router.get('/subject/:subjectId', progressController.getBySubject);
    router.post('/upsert', progressController.upsert);
    router.get('/creator/certificates', progressController.getCreatorCertificates);
    router.post('/creator/certificates/bulk-issue', progressController.bulkIssueCertificates);
    router.post('/course/:courseId/certificate', progressController.issueCertificate);
    router.put('/course/:courseId/certificate-url', progressController.updateCertificateUrl);
    router.post('/course/:courseId/recalculate', progressController.recalculate);

    return router;
}
export default progressRoutes;