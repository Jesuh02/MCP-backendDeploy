import { MCPHttpCompatController } from '../../interfaces/controllers/MCPHttpCompatController.js';

const REDIRECT_MAP = [
    { method: 'use',  from: '/excel',            to: '/api/v1/excel' },
    { method: 'use',  from: '/api/whatsapp',     to: '/api/v1/whatsapp', preserveOriginalUrl: true },
    { method: 'use',  from: '/api/payment',      to: '/api/v1/payment',  preserveOriginalUrl: true },
    { method: 'post', from: '/tts/synthesize',    to: '/api/v1/tts/synthesize' },
    { method: 'post', from: '/procesar-prompt',   to: '/api/v1/llm/process' },
    { method: 'post', from: '/analizar-entrega',  to: '/api/v1/llm/analyze' },
    { method: 'post', from: '/feedback-entrega',  to: '/api/v1/llm/feedback' },
    { method: 'post', from: '/video/analyze',     to: '/api/v1/video-processing/analyze' },
    { method: 'post', from: '/video/process',     to: '/api/v1/video-processing/process' },
    { method: 'post', from: '/video/process-url', to: '/api/v1/video-processing/process-url' },
    { method: 'get',  from: '/video/qualities',   to: '/api/v1/video-processing/qualities' },
    { method: 'get',  from: '/mcp/sse',           to: '/api/v1/mcp/sse' },
    { method: 'post', from: '/mcp/message',       to: '/api/v1/mcp/message' },
    { method: 'post', from: '/mcp',               to: '/api/v1/mcp/message' },
    { method: 'post', from: '/obtener-contenido-submission', to: '/api/v1/submissions/content' },
    { method: 'post', from: '/reinforcement-history', to: '/api/v1/reinforcement/session' },
];

function redirect(app, to) {
    return (req, res, next) => {
        req.url = to;
        app.handle(req, res, next);
    };
}

function redirectWithSuffix(app, baseTo, preserveOriginalUrl) {
    return (req, res, next) => {
        const suffix = req.url;
        if (preserveOriginalUrl) req.originalUrl = `${baseTo}${suffix}`;
        req.url = `${baseTo}${suffix}`;
        app.handle(req, res, next);
    };
}

export function mountLegacyRedirects(app, container) {
    for (const { method, from, to, preserveOriginalUrl } of REDIRECT_MAP) {
        if (method === 'use') {
            app.use(from, redirectWithSuffix(app, to, preserveOriginalUrl));
        } else {
            app[method](from, redirect(app, to));
        }
    }

    app.get('/video/status/:jobId', (req, res, next) => {
        req.url = `/api/v1/video-processing/status/${req.params.jobId}`;
        app.handle(req, res, next);
    });

    app.get('/app-link', (req, res, next) => {
        req.url = `/api/v1/app/app-link?${new URLSearchParams(req.query).toString()}`;
        app.handle(req, res, next);
    });

    app.get('/download-apk', (req, res, next) => {
        req.url = '/api/v1/app/download-apk';
        app.handle(req, res, next);
    });

    app.get('/listar-submissions/:taskId', (req, res, next) => {
        req.url = `/api/v1/submissions/task/${req.params.taskId}`;
        app.handle(req, res, next);
    });

    app.get('/reinforcement-history/:userId/:courseId', (req, res, next) => {
        req.url = `/api/v1/reinforcement/history/user/${req.params.userId}/course/${req.params.courseId}`;
        app.handle(req, res, next);
    });

    const mcpHttpCompat = new MCPHttpCompatController({
        mcpService: container.mcpDomainService,
        mcpServiceLegacy: container.mcpServiceLegacy,
    });
    app.post('/initialize', mcpHttpCompat.initialize);
    app.post('/tools/list', mcpHttpCompat.listTools);
    app.post('/tools/call', mcpHttpCompat.callTool);

    mountLegacyNotifications(app, container);
}

function mountLegacyNotifications(app, container) {
    app.post('/register-fcm-token', async (req, res) => {
        try {
            const { userId, token, deviceType } = req.body;
            if (!userId || !token) return res.status(400).json({ error: 'userId and token are required' });
            await container.userService.registerFCMToken(parseInt(userId), token, deviceType || 'android');
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/notify-chat-response', async (req, res) => {
        try {
            const { userId, messageId, data } = req.body;
            if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
            const notifService = container.notificationService;
            if (!notifService) return res.json({ success: false, error: 'NotificationService not available' });
            await notifService.send(parseInt(userId), {
                title: 'Nueva respuesta del chat',
                message: 'Tu consulta ha sido procesada. Abre la app para ver la respuesta.',
                type: 'chat_response',
                metadata: JSON.stringify({ messageId, fragment: data?.fragment || 'database_query', action: 'OPEN_CHAT', ...data }),
                data,
            });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/send-push-notification', async (req, res) => {
        try {
            const { userId, title, body: notifBody, data } = req.body;
            if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
            const notifService = container.notificationService;
            if (!notifService) return res.json({ success: false, error: 'NotificationService not available' });
            await notifService.send(parseInt(userId), {
                title: title || 'Nueva respuesta',
                message: notifBody || 'Tu consulta ha sido procesada.',
                type: 'push',
                data: data || {},
            });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/send-notification', async (req, res) => {
        try {
            const { userId, title, message, type, relatedId, senderUsername } = req.body;
            if (!userId) return res.status(400).json({ error: 'userId is required' });
            const notifService = container.notificationService;
            if (!notifService) return res.json({ success: false, error: 'NotificationService not available' });
            await notifService.sendNotification({
                userId: parseInt(userId),
                title: title || 'Nueva notificación',
                message: message || '',
                type: type || 'generic',
                relatedId,
                senderUsername,
            });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/notify-grade', async (req, res) => {
        try {
            const { userId, taskName, grade, feedback, gradedByUsername, submissionId, taskId: taskIdFromBody } = req.body;
            if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
            const notifService = container.notificationService;
            if (!notifService) return res.json({ success: false, error: 'NotificationService not available' });

            let resolvedTaskId = taskIdFromBody ? parseInt(taskIdFromBody) : null;
            if (!resolvedTaskId && submissionId && container.submissionService) {
                try {
                    const subResult = await container.submissionService.getById(parseInt(submissionId));
                    if (subResult.isOk()) resolvedTaskId = subResult.getValue().task_id || subResult.getValue().taskId || null;
                } catch (_) {}
            }

            await notifService.sendNotification({
                userId: parseInt(userId),
                title: `Tu tarea "${taskName || 'Tarea'}" ha sido calificada`,
                message: `Nota: ${grade}/10${feedback ? ` — ${feedback.substring(0, 100)}` : ''}`,
                type: 'task_graded',
                relatedId: resolvedTaskId || (submissionId ? parseInt(submissionId) : null),
                senderUsername: gradedByUsername,
            });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/notify-video-upload', async (req, res) => {
        try {
            const { creatorUserId, creatorUsername, videoTitle, courseId, courseTitle, thumbnailUrl } = req.body;
            if (!creatorUserId) return res.status(400).json({ success: false, error: 'creatorUserId required' });
            const { notificationService: notifService, subscriptionService: subService } = container;
            if (!notifService || !subService) return res.json({ success: false, error: 'NotificationService not available' });

            const subsResult = await subService.getSubscribers(parseInt(creatorUserId));
            const subscriberIds = (subsResult.isOk() ? subsResult.getValue() : []).map(s => s.subscriber_id || s.subscriberId);
            if (subscriberIds.length > 0) {
                await notifService.sendBulk(subscriberIds, {
                    title: `${creatorUsername || 'Un creador'} subió un nuevo video`,
                    message: videoTitle || courseTitle || 'Nuevo video disponible',
                    type: 'new_video', relatedId: courseId, senderUsername: creatorUsername, thumbnailUrl,
                });
            }
            res.json({ success: true, notificationsSent: subscriberIds.length });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/notify-course-creation', async (req, res) => {
        try {
            const { creatorUserId, creatorUsername, courseId, courseTitle, courseThumbnailUrl } = req.body;
            if (!creatorUserId || !courseId) return res.status(400).json({ error: 'Missing required fields: creatorUserId, courseId' });
            const { notificationService: notifService, subscriptionService: subService } = container;
            if (!notifService || !subService) return res.json({ success: false, error: 'NotificationService not available' });

            const subsResult = await subService.getSubscribers(parseInt(creatorUserId));
            const subscriberIds = (subsResult.isOk() ? subsResult.getValue() : []).map(s => s.subscriber_id || s.subscriberId);
            if (subscriberIds.length > 0) {
                await notifService.sendBulk(subscriberIds, {
                    title: `${creatorUsername || 'Un creador'} publicó un nuevo curso`,
                    message: courseTitle || 'Nuevo curso disponible',
                    type: 'new_course', relatedId: courseId, senderUsername: creatorUsername, thumbnailUrl: courseThumbnailUrl,
                });
            }
            res.json({ success: true, notificationsSent: subscriberIds.length });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
}
