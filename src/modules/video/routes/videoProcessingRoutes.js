import { Router } from 'express';

export function videoProcessingRoutes({ videoProcessingController }) {
    const router = Router();

    router.post('/analyze', videoProcessingController.analyze);
    router.post('/process', videoProcessingController.process);
    router.post('/process-url', videoProcessingController.processFromUrl);
    router.get('/status/:jobId', videoProcessingController.getJobStatus);
    router.get('/qualities', videoProcessingController.getQualityPresets);

    return router;
}
export default videoProcessingRoutes;

