/**
 * index.js — Entry Point (Bootstrap)
 * reliazadopor jesus
 * Responsabilidad única: cargar configuración y arrancar el servidor.
 * Toda la lógica de negocio vive en src/domain/services/*.
 * Todo el wiring de dependencias vive en src/config/container.js.
 */

// CRITICAL: Load environment variables FIRST
import './src/config/env.js';

import { createApp, startServer } from './src/config/server.js';
import { runStartupMigrations } from './src/shared/database/migrationRunner.js';

// ═══════════════════════════════════════════════════════════
// DIAGNÓSTICO DE ARRANQUE
// ═══════════════════════════════════════════════════════════

const APP_ENV = process.env.APP_ENVIRONMENT || process.env.NODE_ENV || 'development';
const PORT = parseInt(process.env.PORT, 10) || 3000;

console.log('═══════════════════════════════════════════════════');
console.log(' HEXAGONAL ARCHITECTURE v3.0 — BOOTSTRAP');
console.log(` ENVIRONMENT: ${APP_ENV.toUpperCase()}`);
console.log('═══════════════════════════════════════════════════');
console.log(` SUPABASE_URL: ${process.env.SUPABASE_URL ? 'SET' : 'NOT SET'}`);
console.log(` PORT: ${PORT}`);
console.log(` CHAT_MODEL: ${process.env.CHAT_MODEL || process.env.OPENROUTER_CHAT_MODEL || 'default'}`);
console.log(` EMBEDDING_MODEL: ${process.env.EMBEDDING_MODEL || 'default'}`);
console.log('═══════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════
// CREAR APP + ARRANCAR
// ═══════════════════════════════════════════════════════════

const { app, container } = createApp();
const server = startServer(app, PORT);

// Ejecutar migraciones DDL en background (no bloquea el arranque)
runStartupMigrations().catch(() => {/* errores ya logueados en migrationRunner */});

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — Compatible con Railway/Docker
// ═══════════════════════════════════════════════════════════

const SHUTDOWN_TIMEOUT_MS = 10000;

process.on('SIGTERM', () => {
    console.log('SIGTERM received — shutting down gracefully...');
    server.close(() => {
        console.log('Server closed. Exiting.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
    console.error(err.stack);
    // Exit to let Railway restart a clean process instead of running in a broken state
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

// Export for tests
export { app };