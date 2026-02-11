/**
 * ragRoutes — Rutas v1 para RAG (Retrieval-Augmented Generation).
 */

import { Router } from 'express';

export function ragRoutes({ ragController }) {
    const router = Router();

    router.get('/status', ragController.getStatus);
    router.post('/ingest', ragController.ingest);
    router.post('/search', ragController.search);
    router.post('/context', ragController.buildContext);

    return router;
}
export default ragRoutes;