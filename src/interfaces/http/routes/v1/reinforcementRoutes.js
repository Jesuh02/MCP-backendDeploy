import { Router } from 'express';

export function reinforcementRoutes({ reinforcementController }) {
    const router = Router();

    router.post('/session', reinforcementController.saveSession);
    router.post('/save-questions', reinforcementController.saveQuestions);
    router.get('/history/user/:userId/course/:courseId', reinforcementController.getHistory);
    router.get('/history', reinforcementController.getMySessions);

    return router;
}
export default reinforcementRoutes;