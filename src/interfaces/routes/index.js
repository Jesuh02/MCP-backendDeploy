import notificationRoutes from './notificationRoutes.js';
import llmRoutes from './llmRoutes.js';
import excelRoutes from './excelRoutes.js';

/**
 * routes/index.js
 * Exportaciones centralizadas de todas las rutas
 */

export { notificationRoutes, llmRoutes, excelRoutes };

// Route configuration helper
export function configureRoutes(app) {
    const routes = [
        { path: '/', router: notificationRoutes }, // Enabled by user request
        { path: '/', router: llmRoutes }, // Register LLM routes at root (e.g. /procesar-prompt)
        { path: '/', router: excelRoutes } // Register Excel routes at root (e.g. /generate-excel)
    ];

    routes.forEach(({ path, router }) => {
        app.use(path, router);
        console.log(`📍 Routes configured: ${path}`);
    });

    return app;
}

export default {
    notificationRoutes,
    llmRoutes,
    excelRoutes
};
