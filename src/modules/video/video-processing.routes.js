import { Router } from 'express';
import { videoProcessingRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';

export function videoProcessingRoutes({ videoProcessingController }) {
    const router = Router();

    router.post('/analyze', videoProcessingRateLimiter, videoProcessingController.analyze);
    router.post('/process', videoProcessingRateLimiter, videoProcessingController.process);
    router.post('/process-url', videoProcessingRateLimiter, videoProcessingController.processFromUrl);
    router.get('/status/:jobId', videoProcessingController.getJobStatus);
    router.get('/qualities', videoProcessingController.getQualityPresets);

    return router;
}
export default videoProcessingRoutes;

