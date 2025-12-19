/**
 * routes/index.js
 * Exportaciones centralizadas de todas las rutas
 */

export { default as notificationRoutes } from './notificationRoutes.js';
export { default as llmRoutes } from './llmRoutes.js';

// Route configuration helper
export function configureRoutes(app) {
    const routes = [
        // { path: '/', router: notificationRoutes }, // DISABLED: duplicate /procesar-prompt handler
        { path: '/', router: llmRoutes } // Register LLM routes at root (e.g. /procesar-prompt)
    ];

    routes.forEach(({ path, router }) => {
        app.use(path, router);
        console.log(`📍 Routes configured: ${path}`);
    });

    return app;
}

export default {
    notificationRoutes,
    llmRoutes
};
