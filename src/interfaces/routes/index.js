import { Router } from 'express';
import { authRoutes } from '../../modules/auth/routes/authRoutes.js';
import { userRoutes } from '../../modules/user/routes/userRoutes.js';
import { courseRoutes } from '../../modules/course/routes/courseRoutes.js';
import { videoRoutes } from '../../modules/video/routes/videoRoutes.js';
import { topicRoutes } from '../../modules/topic/routes/topicRoutes.js';
import { taskRoutes } from '../../modules/task/routes/taskRoutes.js';
import { contentItemRoutes } from '../../modules/content-item/routes/contentItemRoutes.js';
import { submissionRoutes } from '../../modules/submission/routes/submissionRoutes.js';
import { subscriptionRoutes } from '../../modules/subscription/routes/subscriptionRoutes.js';
import { progressRoutes } from '../../modules/progress/routes/progressRoutes.js';
import { likeRoutes } from '../../modules/like/routes/likeRoutes.js';
import { commentRoutes } from '../../modules/comment/routes/commentRoutes.js';
import { notificationRoutes } from '../../modules/notification/routes/notificationRoutes.js';
import { paymentRoutes } from '../../modules/payment/routes/paymentRoutes.js';
import { storageRoutes } from '../../modules/storage/routes/storageRoutes.js';
import { healthRoutes } from '../../modules/health/routes/healthRoutes.js';
import { personaRoutes } from '../../modules/persona/routes/personaRoutes.js';
import { rolRoutes } from '../../modules/rol/routes/rolRoutes.js';
import { fileContextRoutes } from '../../modules/file-context/routes/fileContextRoutes.js';
import { reinforcementRoutes } from '../../modules/reinforcement/routes/reinforcementRoutes.js';
import { chatMessageRoutes } from '../../modules/chat/routes/chatMessageRoutes.js';
import { ttsRoutes } from '../../modules/tts/routes/ttsRoutes.js';
import { llmRoutes } from '../../modules/ai/routes/llmRoutes.js';
import { videoProcessingRoutes } from '../../modules/video/routes/videoProcessingRoutes.js';
import { videoStreamingRoutes } from '../../modules/video/routes/videoStreamingRoutes.js';
import { ragRoutes } from '../../modules/ai/routes/ragRoutes.js';
import { mcpRoutes } from '../../modules/ai/routes/mcpRoutes.js';
import { appDistributionRoutes } from '../../modules/app-distribution/routes/appDistributionRoutes.js';
import { excelRoutes } from '../../modules/excel/routes/excelRoutes.js';
import { publicRoutes } from '../../modules/health/routes/publicRoutes.js';
import { whatsappRoutes } from '../../modules/whatsapp/routes/whatsappRoutes.js';

export function createRouter(deps) {
    const router = Router();
    const { authMiddleware, requireRoles } = deps;

    router.use('/auth', authRoutes(deps));
    router.use('/', healthRoutes(deps));
    router.use('/public', publicRoutes(deps));

    router.use('/public/streaming/feed', deps.videoStreamingController.feed);

    router.post('/payment/webhook', deps.paymentController.webhook);

    if (deps.optionalAuthMiddleware) {
        router.post('/payment/initiate', deps.optionalAuthMiddleware, deps.paymentController.initiate);
        router.get('/payment/status/:transactionId', deps.optionalAuthMiddleware, deps.paymentController.checkStatus);
    }

    router.use('/mcp', mcpRoutes(deps));
    router.use('/app', appDistributionRoutes(deps));

    if (deps.whatsAppController) {
        router.use('/whatsapp', whatsappRoutes(deps));
    }

    router.use(authMiddleware);

    router.use('/users', userRoutes({...deps, requireRoles }));
    router.use('/courses', courseRoutes(deps));
    router.use('/videos', videoRoutes(deps));
    router.use('/topics', topicRoutes(deps));
    router.use('/tasks', taskRoutes(deps));
    router.use('/content-items', contentItemRoutes(deps));
    router.use('/submissions', submissionRoutes(deps));
    router.use('/subscriptions', subscriptionRoutes(deps));
    router.use('/progress', progressRoutes(deps));
    router.use('/likes', likeRoutes(deps));
    router.use('/comments', commentRoutes(deps));
    router.use('/notifications', notificationRoutes({...deps, requireRoles }));
    router.use('/payment', paymentRoutes(deps));
    router.use('/storage', storageRoutes(deps));
    router.use('/personas', personaRoutes(deps));
    router.use('/roles', rolRoutes(deps));
    router.use('/file-contexts', fileContextRoutes(deps));
    router.use('/reinforcement', reinforcementRoutes(deps));
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

