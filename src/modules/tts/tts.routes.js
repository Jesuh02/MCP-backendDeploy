import { Router } from 'express';
import { ttsRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';

export function ttsRoutes({ ttsController }) {
    const router = Router();

    router.post('/synthesize', ttsRateLimiter, ttsController.synthesize);
    router.get('/capabilities', ttsController.getCapabilities);

    return router;
}
export default ttsRoutes;

