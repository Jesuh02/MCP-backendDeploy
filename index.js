/**
 * index.js — Entry Point (Bootstrap)
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ARQUITECTURA HEXAGONAL v3.0 — Clean Architecture + SOLID      ║
 * ║  Este archivo SOLO inicializa el servidor.                      ║
 * ║  Toda la lógica vive en src/domain/services/*.                  ║
 * ║  Todo el wiring vive en src/config/container.js.                ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Responsabilidad única: cargar configuración y arrancar.
 */

// CRITICAL: Load environment variables FIRST
import './src/config/env.js';

import { createApp, startServer } from './src/config/server.js';
// ═══════════════════════════════════════════════════════════
// DIAGNÓSTICO DE ARRANQUE
// ═══════════════════════════════════════════════════════════

const APP_ENV = process.env.APP_ENVIRONMENT || process.env.NODE_ENV || 'development';
console.log('═══════════════════════════════════════════════════');
console.log('🚀 HEXAGONAL ARCHITECTURE v3.0 — BOOTSTRAP');
console.log(`🏷️  ENVIRONMENT: ${APP_ENV.toUpperCase()}`);
console.log('═══════════════════════════════════════════════════');
console.log(`📌 SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ SET' : '❌ NOT SET'}`);
console.log(`📌 PORT: ${process.env.PORT || 3000}`);
console.log(`📌 CHAT_MODEL: ${process.env.CHAT_MODEL || process.env.OPENROUTER_CHAT_MODEL || 'default'}`);
console.log(`📌 EMBEDDING_MODEL: ${process.env.EMBEDDING_MODEL || 'default'}`);
console.log('═══════════════════════════════════════════════════');
// ═══════════════════════════════════════════════════════════
// CREAR APP + ARRANCAR
// ═══════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT, 10) || 3000;
const { app, container } = createApp();
const server = startServer(app, PORT);

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — Compatible con Railway/Docker
// ═══════════════════════════════════════════════════════════

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received — shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed. Exiting.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
});
process.on('uncaughtException', (err) => {
    console.error('🔴 Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('🟡 Unhandled Rejection:', reason);
});

// Export for tests
export { app };
