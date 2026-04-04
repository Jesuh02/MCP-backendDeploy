import { Router } from 'express';

export function reinforcementResultRoutes({ reinforcementResultController }) {
    const router = Router();

    router.post('/', reinforcementResultController.save);
    router.get('/my', reinforcementResultController.getMy);
    router.get('/all', reinforcementResultController.getAll);
    router.get('/user/:userId', reinforcementResultController.getByUser);
    router.get('/course/:courseId', reinforcementResultController.getByCourse);

    return router;
}

export default reinforcementResultRoutes;
