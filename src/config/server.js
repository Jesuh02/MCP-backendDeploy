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