import { Router } from 'express';

export function subjectRoutes({ subjectController }) {
    const router = Router();

    router.get('/', subjectController.list);
    router.get('/course/:courseId', subjectController.getByCourse);
    router.get('/:id', subjectController.getById);
    router.post('/', subjectController.create);
    router.put('/:id', subjectController.update);
    router.delete('/:id', subjectController.delete);

    return router;
}
export default subjectRoutes;
