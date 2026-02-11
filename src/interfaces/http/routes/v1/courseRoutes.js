import { Router } from 'express';

export function courseRoutes({ courseController }) {
    const router = Router();

    router.get('/', courseController.list);
    router.get('/stats', courseController.getStats);
    router.get('/search', courseController.search);
    router.get('/free', courseController.getFreeCourses);
    router.get('/premium', courseController.getPremiumCourses);
    router.get('/purchased', courseController.getPurchasedCourses);
    router.get('/enrolled', courseController.getEnrolledCourses);
    router.get('/by-ids', courseController.getByIds);
    router.get('/creator/:username', courseController.getByCreator);
    router.get('/creator-id/:userId', courseController.getByCreatorId);
    router.get('/:id', courseController.getById);
    router.post('/', courseController.create);
    router.put('/:id', courseController.update);
    router.delete('/:id', courseController.delete);

    return router;
}
export default courseRoutes;