import { Router } from 'express';

export function videoStreamingRoutes({ videoStreamingController }) {
    const router = Router();

    router.get('/feed', videoStreamingController.feed);
    router.post('/batch-sign', videoStreamingController.batchSign);

    return router;
}

export default videoStreamingRoutes;


