import { Router } from 'express';
import { authRoutes } from '../../modules/auth/auth.routes.js';
import { userRoutes } from '../../modules/user/user.routes.js';
import { courseRoutes } from '../../modules/course/course.routes.js';
import { videoRoutes } from '../../modules/video/video.routes.js';
import { topicRoutes } from '../../modules/topic/topic.routes.js';
import { subjectRoutes } from '../../modules/subject/subject.routes.js';
import { taskRoutes } from '../../modules/task/task.routes.js';
import { contentItemRoutes } from '../../modules/content-item/content-item.routes.js';
import { submissionRoutes } from '../../modules/submission/submission.routes.js';
import { subscriptionRoutes } from '../../modules/subscription/subscription.routes.js';
import { progressRoutes } from '../../modules/progress/progress.routes.js';
import { collaboratorRoutes } from '../../modules/collaborator/collaborator.routes.js';
import { likeRoutes } from '../../modules/like/like.routes.js';
import { commentRoutes } from '../../modules/comment/comment.routes.js';
import { notificationRoutes } from '../../modules/notification/notification.routes.js';
import { paymentRoutes } from '../../modules/payment/payment.routes.js';
import { storageRoutes } from '../../modules/storage/storage.routes.js';
import { healthRoutes } from '../../modules/health/health.routes.js';
import { personaRoutes } from '../../modules/persona/persona.routes.js';
import { rolRoutes } from '../../modules/rol/rol.routes.js';
import { fileContextRoutes } from '../../modules/file-context/file-context.routes.js';
import { reinforcementRoutes } from '../../modules/reinforcement/reinforcement.routes.js';
import { reinforcementResultRoutes } from '../../modules/reinforcement-result/reinforcement-result.routes.js';
import { chatMessageRoutes } from '../../modules/chat/chat.routes.js';
import { ttsRoutes } from '../../modules/tts/tts.routes.js';
import { llmRoutes } from '../../modules/ai/llm.routes.js';
import { videoProcessingRoutes } from '../../modules/video/video-processing.routes.js';
import { videoStreamingRoutes } from '../../modules/video/video-streaming.routes.js';
import { ragRoutes } from '../../modules/ai/rag.routes.js';
import { mcpRoutes } from '../../modules/ai/mcp.routes.js';
import { appDistributionRoutes } from '../../modules/app-distribution/app-distribution.routes.js';
import { excelRoutes } from '../../modules/excel/excel.routes.js';
import { publicRoutes } from '../../modules/health/public.routes.js';
import { institucionRoutes } from '../../modules/institucion/institucion.routes.js';
import { whatsappRoutes } from '../../modules/whatsapp/whatsapp.routes.js';
import { createCourseActiveGuard } from '../../shared/middleware/courseActiveGuard.js';
import { createTenantMiddleware } from '../../shared/middleware/TenantMiddleware.js';
import { publicRegisterRoutes } from '../../modules/auth/public-register.routes.js';

export function createRouter(deps) {
    const router = Router();
    const { authMiddleware, requireRoles, courseRepository, jwtAdapter } = deps;
    const courseActiveGuard = createCourseActiveGuard(courseRepository);

    // ── Tenant context must be resolved first for ALL requests ──
    const tenantMiddleware = createTenantMiddleware(jwtAdapter);
    router.use(tenantMiddleware);

    router.use('/auth', authRoutes(deps));
    router.use('/register', publicRegisterRoutes());
    router.use('/', healthRoutes(deps));
    router.use('/public', publicRoutes(deps));

    router.use('/public/streaming/feed', deps.videoStreamingController.feed);

    router.post('/payment/webhook', deps.paymentController.webhook);

    if (deps.optionalAuthMiddleware) {
        router.post('/payment/initiate', deps.optionalAuthMiddleware, deps.paymentController.initiate);
        router.get('/payment/status/:transactionId', deps.optionalAuthMiddleware, deps.paymentController.checkStatus);
    }

    router.use('/instituciones', institucionRoutes(deps));
    router.use('/mcp', mcpRoutes(deps));
    router.use('/app', appDistributionRoutes(deps));

    if (deps.whatsAppController) {
        router.use('/whatsapp', whatsappRoutes(deps));
    }

    // ── Public polling endpoint: jobId is already a secret, no auth needed ──
    // Registered BEFORE authMiddleware so a token expiry mid-poll doesn't return 401.
    if (deps.reinforcementController) {
        router.get('/reinforcement/poll-generation/:jobId', deps.reinforcementController.pollGeneration);
    }

    router.use(authMiddleware);

    router.use('/users', userRoutes({...deps, requireRoles }));
    router.use('/courses', courseRoutes(deps));
    router.use('/videos', videoRoutes(deps));

    // Apply courseActiveGuard to content modules that access course data by :courseId
    // Roles 1,2 are blocked from inactive courses; role 3 bypasses
    router.use('/subjects/course/:courseId', courseActiveGuard);
    router.use('/topics/course/:courseId', courseActiveGuard);
    router.use('/tasks/course/:courseId', courseActiveGuard);
    router.use('/content-items/course/:courseId', courseActiveGuard);
    router.use('/submissions/course/:courseId', courseActiveGuard);
    router.use('/progress/course/:courseId', courseActiveGuard);
    router.use('/progress/leaderboard/:courseId', courseActiveGuard);

    router.use('/topics', topicRoutes(deps));
    router.use('/subjects', subjectRoutes(deps));
    router.use('/tasks', taskRoutes(deps));
    router.use('/content-items', contentItemRoutes(deps));
    router.use('/submissions', submissionRoutes(deps));
    router.use('/subscriptions', subscriptionRoutes(deps));
    router.use('/progress', progressRoutes({...deps, requireRoles }));
    router.use('/collaborators', collaboratorRoutes(deps));
    router.use('/likes', likeRoutes(deps));
    router.use('/comments', commentRoutes(deps));
    router.use('/notifications', notificationRoutes({...deps, requireRoles }));
    router.use('/payment', paymentRoutes(deps));
    router.use('/storage', storageRoutes(deps));
    router.use('/personas', personaRoutes(deps));
    router.use('/roles', rolRoutes(deps));
    router.use('/file-contexts', fileContextRoutes(deps));
    router.use('/reinforcement', reinforcementRoutes(deps));
    router.use('/reinforcement-results', reinforcementResultRoutes(deps));
    router.use('/chat-messages', chatMessageRoutes(deps));

    router.use('/tts', ttsRoutes(deps));
    router.use('/llm', llmRoutes(deps));
    router.use('/video-processing', videoProcessingRoutes(deps));
    router.use('/streaming', videoStreamingRoutes(deps));
    router.use('/rag', ragRoutes(deps));
    router.use('/excel', excelRoutes(deps));

    return router;
}
export default createRouter;

