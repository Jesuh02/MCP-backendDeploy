import { Router } from 'express';

export function commentRoutes({ commentController }) {
    const router = Router();

    router.get('/video/:videoId', commentController.getByVideo);
    router.get('/video/:videoId/count', commentController.getCount);
    router.post('/', commentController.create);
    router.put('/:id', commentController.update);
    router.delete('/:id', commentController.delete);

    return router;
}
export default commentRoutes;