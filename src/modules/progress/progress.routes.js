import { Router } from 'express';

export function progressRoutes({ progressController, requireRoles }) {
    const router = Router();

    router.get('/my', progressController.getMyProgress);
    router.get('/my/certificates', progressController.getMyCertificates);
    router.get('/my/enrolled-course-ids', progressController.getEnrolledCourseIds);
    router.get('/top-students', progressController.getTopStudents);
    router.get('/creator/enrollment-analytics', progressController.getCreatorEnrollmentAnalytics);
    router.get('/teacher/students', progressController.getTeacherStudentProgress);
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

    router.get('/admin/certificates', requireRoles(3), progressController.getAllCertificates);
    router.post('/admin/certificates/bulk-issue', requireRoles(3), progressController.bulkIssueCertificatesAll);
    router.post('/admin/repair-progress-status', requireRoles(3), progressController.repairProgressStatuses);
    router.get('/admin/subject-progress', requireRoles(2, 3), progressController.getAllSubjectProgress);

    // Admin: enrollment management (Matrícula tab)
    router.get('/admin/pending-enrollments', requireRoles(3), progressController.getPendingEnrollments);
    router.get('/admin/approved-enrollments', requireRoles(3), progressController.getApprovedEnrollments);
    router.post('/admin/enrollments/:userId/:courseId/approve', requireRoles(3), progressController.approveEnrollment);
    router.post('/admin/enrollments/:userId/:courseId/reject', requireRoles(3), progressController.rejectEnrollment);
    router.delete('/admin/enrollments/:userId/:courseId', requireRoles(3), progressController.revokeEnrollment);
    router.post('/admin/enrollments/:userId/:courseId/revoke', requireRoles(3), progressController.revokeEnrollment);
    router.post('/admin/enrollments/:userId/:courseId/restore', requireRoles(3), progressController.restoreEnrollment);

    // Admin: enrollment status toggle (activar / inactivar)
    router.post('/admin/enrollments/:userId/:courseId/enrollment-status', requireRoles(3), progressController.setCourseEnrollmentStatus);
    router.post('/admin/enrollments/:userId/:courseId/subject/:subjectId/enrollment-status', requireRoles(3), progressController.setSubjectEnrollmentStatus);

    // Admin: subject access blocks
    router.get('/admin/subject-access-blocks', requireRoles(3), progressController.getAllSubjectAccessBlocks);
    router.post('/admin/subject-access-block', requireRoles(3), progressController.blockSubjectAccess);
    router.delete('/admin/subject-access-block/:userId/:subjectId', requireRoles(3), progressController.unblockSubjectAccess);

    // Student: check subject access block
    router.get('/subject/:subjectId/access-block', progressController.checkSubjectAccessBlock);
    router.get('/course/:courseId/subject-access-blocks', progressController.getSubjectAccessBlocks);

    // Student: request enrollment
    router.post('/course/:courseId/request-enrollment', progressController.requestEnrollment);
    router.get('/course/:courseId/enrollment-status', progressController.getEnrollmentStatus);

    return router;
}
export default progressRoutes;