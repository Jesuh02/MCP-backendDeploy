import { Router } from 'express';

export function mcpRoutes({ mcpController }) {
    const router = Router();
    router.get('/sse', mcpController.sseConnect);
    router.post('/message', mcpController.handleMessage);
    router.get('/sessions', mcpController.listSessions);

    return router;
}
export default mcpRoutes;

