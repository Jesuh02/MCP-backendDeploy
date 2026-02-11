/**
 * ttsRoutes — Rutas v1 para Text-to-Speech.
 */

import { Router } from 'express';

export function ttsRoutes({ ttsController }) {
    const router = Router();

    router.post('/synthesize', ttsController.synthesize);
    router.get('/capabilities', ttsController.getCapabilities);

    return router;
}
export default ttsRoutes;