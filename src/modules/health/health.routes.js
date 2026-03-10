import { Router } from 'express';

export function healthRoutes({ healthController }) {
    const router = Router();

    router.get('/health', healthController.health);
    router.get('/ping', healthController.ping);

    return router;
}
export default healthRoutes;

