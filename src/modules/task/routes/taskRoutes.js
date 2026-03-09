import { Router } from 'express';

export function taskRoutes({ taskController }) {
    const router = Router();

    router.get('/', taskController.list);
    router.get('/topic/:topicId', taskController.getByTopic);
    router.get('/course/:courseId', taskController.getByCourse);
    router.get('/:id', taskController.getById);
    router.post('/', taskController.create);
    router.put('/:id', taskController.update);
    router.delete('/:id', taskController.delete);

    return router;
}
export default taskRoutes;

