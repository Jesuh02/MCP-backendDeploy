import notificationRoutes from './notificationRoutes.js';
import llmRoutes from './llmRoutes.js';
import excelRoutes from './excelRoutes.js';
import mcpRoutes from './MCPRoutes.js';

/**
 * routes/index.js
 * Exportaciones centralizadas de todas las rutas
 */

export { notificationRoutes, llmRoutes, excelRoutes, mcpRoutes };

// Route configuration helper
export function configureRoutes(app) {
    const routes = [
        { path: '/notifications', router: notificationRoutes, name: 'Notifications' }, 
        { path: '/llm', router: llmRoutes, name: 'LLM' }, 
        { path: '/excel', router: excelRoutes, name: 'Excel' },
        { path: '/', router: mcpRoutes, name: 'MCP' } // MCP routes are mounted at root to handle /tools/call etc.
    ];

    // Mount all at root for backward compatibility but log them clearly
    // Also mount at specific paths for cleaner API structure if needed
    routes.forEach(({ path, router, name }) => {
        // Mount at root as requested by current app architecture
        app.use('/', router);
        console.log(`📍 Route configured: ${name} (mounted at /)`);
    });

    return app;
}

export default {
    notificationRoutes,
    llmRoutes,
    excelRoutes,
    mcpRoutes
};
