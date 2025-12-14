/**
 * routes/index.js
 * Exportaciones centralizadas de todas las rutas
 */

export { default as notificationRoutes } from './notificationRoutes.js';

// Route configuration helper
export function configureRoutes(app) {
    const routes = [
        { path: '/', router: notificationRoutes }
    ];

    routes.forEach(({ path, router }) => {
        app.use(path, router);
        console.log(`📍 Routes configured: ${path}`);
    });

    return app;
}

export default {
    notificationRoutes
};
