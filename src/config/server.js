/**
 * server.js — Configuración Express + Middleware + Bootstrap del servidor.
 *
 * Principio SRP: Este archivo SOLO se encarga de:
 *   1. Crear y configurar la instancia Express
 *   2. Montar middleware de seguridad
 *   3. Montar las rutas v1 (hexagonal)
 *   4. Montar rutas legacy con redirección a /api/v1
 *   5. Arrancar el servidor HTTP
 *
 * NO contiene lógica de negocio. Toda la lógica vive en domain/services.
 */

import express from 'express';
import { networkInterfaces } from 'os';
import { createContainer } from './container.js';
import { createV1Router } from '../interfaces/http/routes/v1/index.js';
import { createAuthMiddleware, requireRoles } from '../infrastructure/middleware/AuthMiddleware.js';
import { errorHandler } from '../infrastructure/middleware/ErrorHandler.js';
import { SupabaseService } from '../infrastructure/database/SupabaseService.js';

/**
 * Crea y configura la aplicación Express con toda la arquitectura hexagonal.
 * @returns {{ app: express.Application, container: Object }}
 */
export function createApp() {
    const app = express();

    // ═══════════════════════════════════════════════════════════
    // 1. MIDDLEWARE DE SEGURIDAD
    // ═══════════════════════════════════════════════════════════

    // Body parsing con límites de seguridad
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // CORS
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-MCP-Client, X-MCP-Request-Id');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    });
    // Request logging (solo en desarrollo)
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (duration > 5000) {
                console.log(`⚠️ Slow request: ${req.method} ${req.path} — ${duration}ms`);
            }
        });
        next();
    });

    // ═══════════════════════════════════════════════════════════
    // 2. DI CONTAINER + RUTAS V1 (HEXAGONAL)
    // ═══════════════════════════════════════════════════════════

    const container = createContainer();
    const authMiddleware = createAuthMiddleware(container.jwtAdapter);
    const v1Router = createV1Router({
        ...container,
        authMiddleware,
        requireRoles,
    });

    // Montar todas las rutas bajo /api/v1
    app.use('/api/v1', v1Router);
    app.use('/api/v1', errorHandler);

    // Rutas Legacy — redirigen a /api/v1 (backward compatibility)
    // Excel legacy → /api/v1/excel
    app.use('/excel', (req, res, next) => {
        req.url = `/api/v1/excel${req.url}`;
        app.handle(req, res, next);
    });

    // ═══════════════════════════════════════════════════════════
    // 3. RUTAS DE COMPATIBILIDAD (Legacy → /api/v1)
    // Redirigen las rutas legacy a sus equivalentes hexagonales
    // ═══════════════════════════════════════════════════════════

    // Legacy TTS → /api/v1/tts
    app.post('/tts/synthesize', (req, res, next) => {
        req.url = '/api/v1/tts/synthesize';
        app.handle(req, res, next);
    });

    // Legacy LLM → /api/v1/llm
    app.post('/procesar-prompt', (req, res, next) => {
        req.url = '/api/v1/llm/process';
        app.handle(req, res, next);
    });

    app.post('/analizar-entrega', (req, res, next) => {
        req.url = '/api/v1/llm/analyze';
        app.handle(req, res, next);
    });

    app.post('/feedback-entrega', (req, res, next) => {
        req.url = '/api/v1/llm/feedback';
        app.handle(req, res, next);
    });

    // Legacy Video Processing → /api/v1/video-processing
    app.post('/video/analyze', (req, res, next) => {
        req.url = '/api/v1/video-processing/analyze';
        app.handle(req, res, next);
    });

    app.post('/video/process', (req, res, next) => {
        req.url = '/api/v1/video-processing/process';
        app.handle(req, res, next);
    });

    app.post('/video/process-url', (req, res, next) => {
        req.url = '/api/v1/video-processing/process-url';
        app.handle(req, res, next);
    });

    app.get('/video/status/:jobId', (req, res, next) => {
        req.url = `/api/v1/video-processing/status/${req.params.jobId}`;
        app.handle(req, res, next);
    });

    app.get('/video/qualities', (req, res, next) => {
        req.url = '/api/v1/video-processing/qualities';
        app.handle(req, res, next);
    });

    // Legacy RAG → /api/v1/rag
    app.get('/api/v1/rag/status', (req, res, next) => {
        // Ya está en v1, no need redirect
        next();
    });

    // Legacy MCP → /api/v1/mcp
    app.get('/mcp/sse', (req, res, next) => {
        req.url = '/api/v1/mcp/sse';
        app.handle(req, res, next);
    });

    app.post('/mcp/message', (req, res, next) => {
        req.url = '/api/v1/mcp/message';
        app.handle(req, res, next);
    });

    app.post('/mcp', (req, res, next) => {
        req.url = '/api/v1/mcp/message';
        app.handle(req, res, next);
    });

    // ═══════════════════════════════════════════════════════════
    // 3.5. MCP HTTP TOOL ENDPOINTS (Android MCPHttpClient compat)
    //
    // The Android app's MCPHttpClient sends direct HTTP requests to
    // /initialize, /tools/list, /tools/call using JSON-RPC format.
    // These endpoints replicate the standalone mcp-http.js server
    // so the deployed Railway backend handles them.
    // ═══════════════════════════════════════════════════════════

    let _mcpHttpService = null;
    function getMCPHttpService() {
        if (!_mcpHttpService) {
            try {
                _mcpHttpService = new MCPService();
            } catch (e) {
                console.error('❌ Failed to init MCPService for HTTP tools:', e.message);
            }
        }
        return _mcpHttpService;
    }

    // MCP Initialize — Android client calls this to handshake
    app.post('/initialize', async (req, res) => {
        console.log('🔧 MCP Initialize request (Android compat)');
        try {
            const supabase = SupabaseService.getInstance();
            await supabase.testConnection();

            res.json({
                jsonrpc: '2.0',
                id: req.body?.id || 1,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: { listChanged: true },
                        resources: { subscribe: true, listChanged: true },
                    },
                    serverInfo: {
                        name: 'YisusCompany by YisusFactory MCP Server',
                        version: '3.0.0',
                    },
                },
            });
        } catch (error) {
            console.error('❌ Initialize error:', error);
            res.status(500).json({
                jsonrpc: '2.0',
                id: req.body?.id || 1,
                error: { code: -32603, message: 'Internal error', data: error.message },
            });
        }
    });

    // MCP Tools List — Android client discovers available tools
    app.post('/tools/list', (req, res) => {
        console.log('🔧 Tools list request (Android compat)');
        res.json({
            jsonrpc: '2.0',
            id: req.body?.id || 1,
            result: {
                tools: [
                    {
                        name: 'query_database',
                        description: 'Execute queries on the YisusCompany Supabase database. Accepts raw SQL or natural language.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: { type: 'string', description: 'SQL or natural language query' },
                            },
                            required: ['query'],
                        },
                    },
                    {
                        name: 'get_database_schema',
                        description: 'Get the complete database schema with all tables and columns.',
                        inputSchema: { type: 'object', properties: {} },
                    },
                    {
                        name: 'analyze_github_repo',
                        description: 'Analyze and grade a GitHub repository.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                repoUrl: { type: 'string', description: 'GitHub repository URL' },
                                criteria: { type: 'string', description: 'Evaluation criteria' },
                                taskDescription: { type: 'string', description: 'Task description' },
                            },
                            required: ['repoUrl'],
                        },
                    },
                ],
            },
        });
    });

    // MCP Tools Call — Android client executes tools (query_database, etc.)
    app.post('/tools/call', async (req, res) => {
        const { params } = req.body;
        console.log('🔧 Tool call (Android compat):', params?.name);

        try {
            const mcpSvc = getMCPHttpService();
            if (!mcpSvc) throw new Error('MCPService not initialized');

            const { name, arguments: args } = params;

            if (name === 'query_database') {
                let result;
                const isSQL = /^\s*(select|insert|update|delete|with)\s/i.test(args.query);

                if (isSQL) {
                    console.log('📊 Executing raw SQL (Android)...');
                    result = await mcpSvc.processQuery(args.query, { includeSchema: true });
                } else {
                    console.log('🤖 NL query via Agent (Android)...');
                    try {
                        const agentResponse = await mcpSvc.processQueryWithAgent(args.query);
                        result = { data: agentResponse, sqlScript: '-- Executed via LLM Agent' };
                    } catch (agentErr) {
                        console.error('❌ Agent error:', agentErr);
                        result = { error: true, message: `Error del agente LLM: ${agentErr.message}` };
                    }
                }

                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
                });
            } else if (name === 'get_database_schema') {
                const schema = await mcpSvc.getDatabaseSchema();
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: { content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }] },
                });
            } else if (name === 'analyze_github_repo') {
                console.log('🐙 Analyzing GitHub repo (Android):', args.repoUrl);
                const ghResult = await mcpSvc.analyzeGitHubRepo(args.repoUrl, {
                    taskDescription: args.taskDescription,
                    gradingCriteria: args.gradingCriteria,
                });
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: { content: [{ type: 'text', text: JSON.stringify(ghResult, null, 2) }] },
                });
            } else {
                res.status(404).json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    error: { code: -32601, message: `Tool not found: ${name}` },
                });
            }
        } catch (error) {
            console.error('❌ Tool call error:', error);
            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{ type: 'text', text: `❌ Error: ${error.message}` }],
                },
            });
        }
    });

    // Notification endpoint — Android sends email/push notifications after chat
    app.post('/notify-chat-response', async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

            // Use the notification service from the container
            const notifService = container.notificationService;
            if (notifService) {
                await notifService.send(userId, {
                    title: '🤖 Nueva respuesta del chat',
                    message: 'Tu consulta ha sido procesada. Abre la app para ver la respuesta.',
                    type: 'chat_response',
                });
            }

            res.json({ success: true });
        } catch (error) {
            console.error('❌ notify-chat-response error:', error.message);
            res.json({ success: false, error: error.message });
        }
    });

    // Push notification endpoint — Android sends push when app is in background
    app.post('/send-push-notification', async (req, res) => {
        try {
            const { userId, title, body: notifBody, data } = req.body;
            if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

            const notifService = container.notificationService;
            if (notifService) {
                await notifService.send(userId, {
                    title: title || '🤖 Nueva respuesta',
                    message: notifBody || 'Tu consulta ha sido procesada.',
                    type: 'push',
                    data: data || {},
                });
            }

            res.json({ success: true });
        } catch (error) {
            console.error('❌ send-push-notification error:', error.message);
            res.json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // 3.6. LEGACY REDIRECTS — Android backward compatibility
    //
    // Estos endpoints legacy se redirigen a la arquitectura
    // hexagonal /api/v1 para mantener compatibilidad con la app.
    // ═══════════════════════════════════════════════════════════

    // App Distribution — Smart link y APK download
    app.get('/app-link', (req, res, next) => {
        req.url = `/api/v1/app/app-link?${new URLSearchParams(req.query).toString()}`;
        app.handle(req, res, next);
    });

    app.get('/download-apk', (req, res, next) => {
        req.url = '/api/v1/app/download-apk';
        app.handle(req, res, next);
    });

    // Submissions — obtener contenido de archivo de entrega
    app.post('/obtener-contenido-submission', (req, res, next) => {
        req.url = '/api/v1/submissions/content';
        app.handle(req, res, next);
    });

    // Submissions — listar entregas de una tarea
    app.get('/listar-submissions/:taskId', (req, res, next) => {
        req.url = `/api/v1/submissions/task/${req.params.taskId}`;
        app.handle(req, res, next);
    });

    // FCM token registration
    app.post('/register-fcm-token', async (req, res) => {
        try {
            const { userId, token, deviceType } = req.body;
            if (!userId || !token) {
                return res.status(400).json({ error: 'userId and token are required' });
            }
            await container.userService.registerFCMToken(parseInt(userId), token, deviceType || 'android');
            res.json({ success: true, message: 'Token registered successfully' });
        } catch (error) {
            console.error('❌ Error registering FCM token:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // Notify grade — Android sends grade notification to student
    app.post('/notify-grade', async (req, res) => {
        try {
            const { userId, taskName, grade, feedback, gradedByUsername, submissionId } = req.body;
            if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

            const notifService = container.notificationService;
            if (notifService) {
                await notifService.sendNotification({
                    userId: parseInt(userId),
                    title: `📊 Tu tarea "${taskName || 'Tarea'}" ha sido calificada`,
                    message: `Nota: ${grade}/10${feedback ? ` — ${feedback.substring(0, 100)}` : ''}`,
                    type: 'task_graded',
                    relatedId: submissionId,
                    senderUsername: gradedByUsername,
                });
            }

            res.json({ success: true });
        } catch (error) {
            console.error('❌ notify-grade error:', error.message);
            res.json({ success: false, error: error.message });
        }
    });

    // Notify video upload — notifica suscriptores de nuevo video
    app.post('/notify-video-upload', async (req, res) => {
        try {
            const { creatorUserId, creatorUsername, videoTitle, courseId, courseTitle, thumbnailUrl } = req.body;
            if (!creatorUserId) return res.status(400).json({ success: false, error: 'creatorUserId required' });

            const notifService = container.notificationService;
            const subService = container.subscriptionService;

            if (notifService && subService) {
                const subsResult = await subService.getSubscribers(parseInt(creatorUserId));
                const subscribers = subsResult.isOk() ? subsResult.getValue() : [];

                let sent = 0;
                for (const sub of subscribers) {
                    try {
                        await notifService.sendNotification({
                            userId: sub.subscriber_id || sub.subscriberId,
                            title: `🎬 ${creatorUsername || 'Un creador'} subió un nuevo video`,
                            message: videoTitle || courseTitle || 'Nuevo video disponible',
                            type: 'new_video',
                            relatedId: courseId,
                            senderUsername: creatorUsername,
                            thumbnailUrl,
                        });
                        sent++;
                    } catch (e) {
                        console.warn(`⚠️ Failed to notify subscriber ${sub.subscriber_id}:`, e.message);
                    }
                }
                res.json({ success: true, notificationsSent: sent });
            } else {
                res.json({ success: false, error: 'NotificationService not available' });
            }
        } catch (error) {
            console.error('❌ notify-video-upload error:', error.message);
            res.json({ success: false, error: error.message });
        }
    });

    // Notify course creation — notifica suscriptores de nuevo curso
    app.post('/notify-course-creation', async (req, res) => {
        try {
            const { creatorUserId, creatorUsername, courseId, courseTitle, courseThumbnailUrl } = req.body;
            if (!creatorUserId || !courseId) {
                return res.status(400).json({ error: 'Missing required fields: creatorUserId, courseId' });
            }

            const notifService = container.notificationService;
            const subService = container.subscriptionService;

            if (notifService && subService) {
                const subsResult = await subService.getSubscribers(parseInt(creatorUserId));
                const subscribers = subsResult.isOk() ? subsResult.getValue() : [];

                let sent = 0;
                for (const sub of subscribers) {
                    try {
                        await notifService.sendNotification({
                            userId: sub.subscriber_id || sub.subscriberId,
                            title: `📚 ${creatorUsername || 'Un creador'} publicó un nuevo curso`,
                            message: courseTitle || 'Nuevo curso disponible',
                            type: 'new_course',
                            relatedId: courseId,
                            senderUsername: creatorUsername,
                            thumbnailUrl: courseThumbnailUrl,
                        });
                        sent++;
                    } catch (e) {
                        console.warn(`⚠️ Failed to notify subscriber ${sub.subscriber_id}:`, e.message);
                    }
                }
                res.json({ success: true, notificationsSent: sent });
            } else {
                res.json({ success: false, error: 'NotificationService not available' });
            }
        } catch (error) {
            console.error('❌ notify-course-creation error:', error.message);
            res.json({ success: false, error: error.message });
        }
    });

    // Generic send-notification combo (push + email)
    app.post('/send-notification', async (req, res) => {
        try {
            const { userId, title, message, type, relatedId, senderUsername } = req.body;
            if (!userId) return res.status(400).json({ error: 'userId is required' });

            const notifService = container.notificationService;
            if (notifService) {
                await notifService.sendNotification({
                    userId: parseInt(userId),
                    title: title || 'Nueva notificación',
                    message: message || '',
                    type: type || 'generic',
                    relatedId,
                    senderUsername,
                });
                res.json({ success: true });
            } else {
                res.json({ success: false, error: 'NotificationService not available' });
            }
        } catch (error) {
            console.error('❌ send-notification error:', error.message);
            res.json({ success: false, error: error.message });
        }
    });

    // Reinforcement history — save and fetch
    app.post('/reinforcement-history', async (req, res) => {
        try {
            const { userId, courseId, questions } = req.body;
            if (!userId || !courseId || !questions) {
                return res.status(400).json({ success: false, error: 'Missing userId, courseId or questions' });
            }
            const reinforcementRepo = container.reinforcementService?.reinforcementRepo;
            if (reinforcementRepo) {
                await reinforcementRepo.saveHistory(parseInt(userId), parseInt(courseId), questions);
                return res.json({ success: true, message: 'Reinforcement history saved' });
            }
            res.json({ success: false, error: 'ReinforcementService not available' });
        } catch (err) {
            console.error('Error saving reinforcement history:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/reinforcement-history/:userId/:courseId', async (req, res) => {
        try {
            const userId = parseInt(req.params.userId);
            const courseId = parseInt(req.params.courseId);
            if (!userId || !courseId) {
                return res.status(400).json({ success: false, error: 'Missing userId or courseId' });
            }
            const reinforcementRepo = container.reinforcementService?.reinforcementRepo;
            if (reinforcementRepo) {
                const history = await reinforcementRepo.getHistory(userId, courseId);
                return res.json({ success: true, data: history || [] });
            }
            res.json({ success: false, data: [] });
        } catch (err) {
            console.error('Error fetching reinforcement history:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // 4. HEALTH CHECK ENDPOINTS
    // ═══════════════════════════════════════════════════════════

    const healthPayload = () => ({
        status: 'ok',
        version: '3.0.0',
        architecture: 'hexagonal',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });

    app.get('/', (req, res) => res.json(healthPayload()));
    app.get('/health', (req, res) => res.json(healthPayload()));
    app.get('/_health', (req, res) => res.status(200).send('OK'));

    app.get('/ping-debug', (req, res) => {
        res.json({
            ...healthPayload(),
            clientIp: req.ip,
            headers: req.headers,
        });
    });

    // ═══════════════════════════════════════════════════════════
    // 5. GLOBAL ERROR HANDLER
    // ═══════════════════════════════════════════════════════════

    app.use(errorHandler);

    return { app, container };
}

/**
 * Arranca el servidor HTTP.
 * @param {express.Application} app
 * @param {number} port
 * @returns {http.Server}
 */
export function startServer(app, port = 3000) {
    const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';

    const server = app.listen(port, BIND_HOST, () => {
        console.log('');
        console.log('═══════════════════════════════════════════════════');
        console.log('🏗️  HEXAGONAL ARCHITECTURE v3.0 — CLEAN BOOTSTRAP');
        console.log('═══════════════════════════════════════════════════');
        console.log(`🌐 Server: http://${BIND_HOST}:${port}`);
        console.log(`📌 Environment: ${process.env.APP_ENVIRONMENT || process.env.NODE_ENV || 'development'}`);
        console.log(`📌 API Base: /api/v1`);
        console.log('');
        console.log('📍 Domains mounted:');
        console.log('   Auth, Users, Courses, Videos, Topics, Tasks,');
        console.log('   ContentItems, Submissions, Subscriptions, Progress,');
        console.log('   Likes, Comments, Notifications, Payments, Storage,');
        console.log('   Personas, Roles, FileContexts, Reinforcement,');
        console.log('   TTS, LLM, VideoProcessing, RAG, MCP');
        console.log('═══════════════════════════════════════════════════');

        // Show LAN IP
        const interfaces = networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`📱 LAN: http://${iface.address}:${port}`);
                }
            }
        }
        console.log('');
    });

    // Server timeouts
    server.setTimeout(300000); // 5 min
    server.keepAliveTimeout = 120 * 1000;
    server.headersTimeout = 121 * 1000;

    return server;
}

export default { createApp, startServer };