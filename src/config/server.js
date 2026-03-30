import express from 'express';
import { networkInterfaces } from 'os';
import { createContainer } from './container.js';
import { createRouter } from '../interfaces/routes/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireRoles } from '../shared/middleware/AuthMiddleware.js';
import { errorHandler } from '../shared/middleware/ErrorHandler.js';
import { mountLegacyRedirects } from '../shared/middleware/LegacyRedirects.js';
import { idempotencyGuard } from '../shared/middleware/IdempotencyMiddleware.js';

export function createApp() {
    const app = express();

    app.use(express.json({
        limit: '5mb',
        verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
    }));
    app.use(express.urlencoded({ extended: true, limit: '5mb' }));

    const ALLOWED_ORIGINS = [
        'https://coursevwebfrontend1.jdavidherazo.workers.dev',
        // Agrega aquí otros orígenes de confianza
    ];

    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && ALLOWED_ORIGINS.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Vary', 'Origin');
        }
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-MCP-Client, X-MCP-Request-Id, X-Tenant-Id');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (duration > 5000) console.log(`Slow request: ${req.method} ${req.path} — ${duration}ms`);
        });
        next();
    });

    const container = createContainer();
    const authMiddleware = createAuthMiddleware(container.jwtAdapter);
    const optionalAuthMiddleware = createOptionalAuthMiddleware(container.jwtAdapter);

    const router = createRouter({
        ...container,
        authMiddleware,
        optionalAuthMiddleware,
        requireRoles,
    });

    app.use('/api/v1', idempotencyGuard, router);
    app.use('/api/v1', errorHandler);

    mountLegacyRedirects(app, container);
    mountHealthChecks(app);

    app.use(errorHandler);

    return { app, container };
}

function mountHealthChecks(app) {
    const healthPayload = () => ({
        status: 'ok',
        version: '3.0.0',
        architecture: 'hexagonal',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });

    app.get('/', (_req, res) => res.json(healthPayload()));
    app.get('/health', (_req, res) => res.json(healthPayload()));
    app.get('/_health', (_req, res) => res.status(200).send('OK'));

    app.get('/ping-debug', (req, res) => {
        res.json({ ...healthPayload(), clientIp: req.ip, headers: req.headers });
    });

    app.get('/api/v1/diagnostics/quick', (_req, res) => {
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            diagnostics: {
                server: healthPayload(),
                supabase_config: {
                    url: process.env.SUPABASE_URL ? 'SET' : 'NOT SET',
                    service_key: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'NOT SET',
                    anon_key: process.env.SUPABASE_KEY ? 'SET' : 'NOT SET',
                },
                storage_config: {
                    r2_available: !!process.env.R2_ACCOUNT_ID,
                    bucket: process.env.R2_BUCKET_NAME || 'unknown',
                },
                environment: {
                    node_env: process.env.NODE_ENV,
                    app_env: process.env.APP_ENVIRONMENT,
                },
            },
        });
    });
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

