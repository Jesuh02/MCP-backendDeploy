import { Router } from 'express';

export function likeRoutes({ likeController }) {
    const router = Router();

    router.post('/toggle', likeController.toggle);
    router.get('/count/:entityType/:entityId', likeController.getCount);
    router.get('/status/:entityType', likeController.getStatus);

    return router;
}
export default likeRoutes;