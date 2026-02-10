import { Router } from 'express';

export function reinforcementRoutes({ reinforcementController }) {
    const router = Router();

    router.post('/session', reinforcementController.saveSession);
    router.get('/history/course/:courseId', reinforcementController.getByUserAndCourse);
    router.get('/history', reinforcementController.getByUser);

    return router;
}
export default reinforcementRoutes;