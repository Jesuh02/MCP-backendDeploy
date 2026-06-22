import { Router } from 'express';

export function reinforcementRoutes({ reinforcementController }) {
    const router = Router();

    // ═══ Fast endpoints (cache-based, <100ms) ═══
    router.get('/cached-questions', reinforcementController.getCachedQuestions);
    router.post('/prefetch', reinforcementController.prefetch);

    // ═══ Unified server-side generation (replaces 3-step client flow) ═══
    router.post('/generate-questions', reinforcementController.generateQuestions);
    router.post('/coach', reinforcementController.coachConversation);

    // ═══ Polling-based generation (avoids long HTTP connections) ═══
    router.post('/start-generation', reinforcementController.startGeneration);
    router.get('/poll-generation/:jobId', reinforcementController.pollGeneration);

    // ═══ Existing endpoints ═══
    router.post('/session', reinforcementController.saveSession);
    router.post('/save-questions', reinforcementController.saveQuestions);
    router.post('/ingest-context', reinforcementController.ingestContext);
    router.get('/existing-questions', reinforcementController.getExistingQuestions);
    router.get('/rag-content', reinforcementController.getRagContent);
    router.get('/learning-context', reinforcementController.getLearningContext);
    router.get('/history/user/:userId/course/:courseId', reinforcementController.getHistory);
    router.get('/history', reinforcementController.getMySessions);

    // ═══ Cognitive Analytics Dashboard ═══
    router.get('/cognitive-access', reinforcementController.getCognitiveAccess);
    router.get('/cognitive-analytics', reinforcementController.getCognitiveAnalytics);

    // ═══ Stealth Assessment (Evaluación Invisible) ═══
    // Paper: Stealth Assessment in Digital Games (Valerie Shute, 2011)
    router.post('/stealth-assessment', reinforcementController.saveStealthAssessment);
    router.get('/stealth-assessment/xray', reinforcementController.getComprehensionXRay);
    router.get('/stealth-assessment/course-analytics', reinforcementController.getCourseStealthAnalytics);

    return router;
}
export default reinforcementRoutes;

