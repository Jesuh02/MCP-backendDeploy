import { Router } from 'express';

export function likeRoutes({ likeController }) {
    const router = Router();

    router.post('/toggle', likeController.toggle);
    router.get('/check/:entityType/:entityId', likeController.checkSingle);
    router.get('/count/:entityType/:entityId', likeController.getCount);
    router.get('/status/:entityType', likeController.getStatus);

    return router;
}
export default likeRoutes;