import { Router } from 'express';

export function contentItemRoutes({ contentItemController }) {
    const router = Router();

    router.get('/task/:taskId', contentItemController.getByTask);
    router.get('/topic/:topicId', contentItemController.getByTopic);
    router.get('/:id', contentItemController.getById);
    router.post('/', contentItemController.create);
    router.put('/:id', contentItemController.update);
    router.delete('/by-task/:taskId', contentItemController.deleteByTask);
    router.delete('/:id', contentItemController.delete);

    return router;
}
export default contentItemRoutes;