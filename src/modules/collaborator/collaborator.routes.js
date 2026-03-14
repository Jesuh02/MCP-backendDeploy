import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';

export function collaboratorRoutes({ collaboratorController }) {
    const router = Router();

    router.get('/course/:courseId', asyncHandler(collaboratorController.getByCourse));
    router.post('/course/:courseId', asyncHandler(collaboratorController.add));
    router.put('/course/:courseId/sync', asyncHandler(collaboratorController.sync));
    router.delete('/course/:courseId/user/:userId', asyncHandler(collaboratorController.remove));

    return router;
}
export default collaboratorRoutes;
