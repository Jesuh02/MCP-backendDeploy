import { Router } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';

export function courseRoutes({ courseController }) {
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
    router.get('/creator-id/:userId/with-submissions', asyncHandler(courseController.getCreatorCoursesWithSubmissions));
    router.get('/:id', asyncHandler(courseController.getById));
    router.post('/', asyncHandler(courseController.create));
    router.put('/:id', asyncHandler(courseController.update));
    router.delete('/:id', asyncHandler(courseController.delete));

    return router;
}
export default courseRoutes;