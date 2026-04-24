import { Router } from 'express';

export function icfesRoutes({ icfesController }) {
    const router = Router();
    router.get('/areas', icfesController.listAreas);
    router.post('/exam/start', icfesController.start);
    router.post('/exam/submit', icfesController.submit);
    router.get('/results/my', icfesController.history);
    return router;
}

export default icfesRoutes;
