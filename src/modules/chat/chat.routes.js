import { Router } from 'express';

export function chatMessageRoutes({ chatMessageController }) {
    const router = Router();

    router.get('/my', chatMessageController.getByUser);
    router.get('/session/:sessionId', chatMessageController.getBySession);
    router.get('/:id', chatMessageController.getById);
    router.post('/upsert', chatMessageController.upsert);
    router.post('/', chatMessageController.create);
    router.delete('/session/:sessionId', chatMessageController.deleteBySession);
    router.delete('/:id', chatMessageController.delete);

    return router;
}

export default chatMessageRoutes;

