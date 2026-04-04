import { Router } from 'express';
import { aiRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';

export function llmRoutes({ llmController }) {
    const router = Router();

    router.post('/process', aiRateLimiter, llmController.processPrompt);
    router.post('/analyze', aiRateLimiter, llmController.analyzeSubmission);
    router.post('/feedback', aiRateLimiter, llmController.feedbackSubmission);

    return router;
}
export default llmRoutes;

