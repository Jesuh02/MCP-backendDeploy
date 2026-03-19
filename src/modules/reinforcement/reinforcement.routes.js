import { Router } from 'express';

export function reinforcementRoutes({ reinforcementController }) {
    const router = Router();

    // ═══ Fast endpoints (cache-based, <100ms) ═══
    router.get('/cached-questions', reinforcementController.getCachedQuestions);
    router.post('/prefetch', reinforcementController.prefetch);

    // ═══ Unified server-side generation (replaces 3-step client flow) ═══
    router.post('/generate-questions', reinforcementController.generateQuestions);

    // ═══ Existing endpoints ═══
    router.post('/session', reinforcementController.saveSession);
    router.post('/save-questions', reinforcementController.saveQuestions);
    router.post('/ingest-context', reinforcementController.ingestContext);
    router.get('/existing-questions', reinforcementController.getExistingQuestions);
    router.get('/rag-content', reinforcementController.getRagContent);
    router.get('/learning-context', reinforcementController.getLearningContext);
    router.get('/history/user/:userId/course/:courseId', reinforcementController.getHistory);
    router.get('/history', reinforcementController.getMySessions);

    return router;
}
export default reinforcementRoutes;

