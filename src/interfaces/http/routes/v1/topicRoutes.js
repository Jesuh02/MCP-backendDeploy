import { Router } from 'express';

export function topicRoutes({ topicController }) {
    const router = Router();

    router.get('/course/:courseId', topicController.getByCourse);
    router.get('/:id', topicController.getById);
    router.post('/', topicController.create);
    router.put('/:id', topicController.update);
    router.delete('/:id', topicController.delete);

    return router;
}
export default topicRoutes;