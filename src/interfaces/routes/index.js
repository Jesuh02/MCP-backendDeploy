import { Router } from 'express';
import { authRoutes } from './authRoutes.js';
import { userRoutes } from './userRoutes.js';
import { courseRoutes } from './courseRoutes.js';
import { videoRoutes } from './videoRoutes.js';
import { topicRoutes } from './topicRoutes.js';
import { taskRoutes } from './taskRoutes.js';
import { contentItemRoutes } from './contentItemRoutes.js';
import { submissionRoutes } from './submissionRoutes.js';
import { subscriptionRoutes } from './subscriptionRoutes.js';
import { progressRoutes } from './progressRoutes.js';
import { likeRoutes } from './likeRoutes.js';
import { commentRoutes } from './commentRoutes.js';
import { notificationRoutes } from './notificationRoutes.js';
import { paymentRoutes } from './paymentRoutes.js';
import { storageRoutes } from './storageRoutes.js';
import { healthRoutes } from './healthRoutes.js';
import { personaRoutes } from './personaRoutes.js';
import { rolRoutes } from './rolRoutes.js';
import { fileContextRoutes } from './fileContextRoutes.js';
import { reinforcementRoutes } from './reinforcementRoutes.js';
import { chatMessageRoutes } from './chatMessageRoutes.js';
import { ttsRoutes } from './ttsRoutes.js';
import { llmRoutes } from './llmRoutes.js';
import { videoProcessingRoutes } from './videoProcessingRoutes.js';
import { videoStreamingRoutes } from './videoStreamingRoutes.js';
import { ragRoutes } from './ragRoutes.js';
import { mcpRoutes } from './mcpRoutes.js';
import { appDistributionRoutes } from './appDistributionRoutes.js';
import { excelRoutes } from './excelRoutes.js';
import { publicRoutes } from './publicRoutes.js';
import { whatsappRoutes } from './whatsappRoutes.js';

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

