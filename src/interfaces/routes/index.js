/**
 * routes/index.js
 * Exportaciones centralizadas de todas las rutas
 */

import notificationRoutes from './notificationRoutes.js';
import llmRoutes from './llmRoutes.js';
export { notificationRoutes, llmRoutes };

// Route configuration helper
export function configureRoutes(app) {
    const routes = [
        { path: '/', router: notificationRoutes },
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
