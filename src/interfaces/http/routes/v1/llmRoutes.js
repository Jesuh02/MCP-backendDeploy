/**
 * llmRoutes — Rutas v1 para procesamiento LLM.
 */

import { Router } from 'express';

export function llmRoutes({ llmController }) {
    const router = Router();

    router.post('/process', llmController.processPrompt);
    router.post('/analyze', llmController.analyzeSubmission);
    router.post('/feedback', llmController.feedbackSubmission);

    return router;
}
export default llmRoutes;

