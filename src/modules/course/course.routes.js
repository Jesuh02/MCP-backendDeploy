import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../shared/middleware/validate.js';
import { createCourseSchema, updateCourseSchema } from './course.schemas.js';

export function courseRoutes({ courseController, courseGuestController }) {
    const router = Router();

    router.get('/', asyncHandler(courseController.list));
    router.get('/stats', asyncHandler(courseController.getStats));
    router.get('/counts', asyncHandler(courseController.getFilterCounts));
    router.get('/search', asyncHandler(courseController.search));
    router.get('/popular', asyncHandler(courseController.getPopularCourses));
    router.get('/free', asyncHandler(courseController.getFreeCourses));
    router.get('/premium', asyncHandler(courseController.getPremiumCourses));
    router.get('/purchased', asyncHandler(courseController.getPurchasedCourses));
    router.get('/enrolled', asyncHandler(courseController.getEnrolledCourses));
    router.get('/by-ids', asyncHandler(courseController.getByIds));
    router.get('/my/creator-metrics', asyncHandler(courseController.getMyCreatorMetrics));
    router.get('/creator/:username', asyncHandler(courseController.getByCreator));
    router.get('/creator-id/:userId', asyncHandler(courseController.getByCreatorId));
    router.get('/manageable/:userId', asyncHandler(courseController.getManageableByUserId));
    router.get('/creator-id/:userId/with-submissions', asyncHandler(courseController.getCreatorCoursesWithSubmissions));
    router.get('/:id', asyncHandler(courseController.getById));
    router.post('/', validate(createCourseSchema), asyncHandler(courseController.create));
    router.put('/:id', validate(updateCourseSchema), asyncHandler(courseController.update));
    router.delete('/:id', asyncHandler(courseController.delete));

    // ── Guest / Invitados ──────────────────────────────────────────────────────
    if (courseGuestController) {
        router.post('/:courseId/guests', asyncHandler(courseGuestController.invite));
        router.get('/:courseId/guests', asyncHandler(courseGuestController.list));
        router.delete('/:courseId/guests/:userId', asyncHandler(courseGuestController.remove));
    }

    return router;
}
export default courseRoutes;