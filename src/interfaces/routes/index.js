/**
 * routes/index.js (Legacy)
 *
 * @deprecated Este archivo está DEPRECADO.
 * Todas las rutas ahora se montan vía la arquitectura hexagonal en:
 *   - src/interfaces/http/routes/v1/index.js (createV1Router)
 *   - server.js monta v1Router bajo /api/v1
 *
 * Los archivos de rutas legacy en este directorio han sido:
 *   - MCPRoutes.js → Refactorizado con factory function (DI)
 *   - courseRoutes.js → Deprecado (migrado a v1/courseRoutes.js)
 *   - notificationRoutes.js → Deprecado (migrado a v1/notificationRoutes.js)
 *   - paymentRoutes.js → Deprecado (redirigido a v1/paymentRoutes.js)
 *   - llmRoutes.js → Deprecado (migrado a v1/llmRoutes.js)
 *   - excelRoutes.js → Deprecado (migrado a v1/excelRoutes.js)
 *   - RAGRoutes.js → Deprecado (migrado a v1/ragRoutes.js)
 *   - ttsRoutes.js → Deprecado (migrado a v1/ttsRoutes.js)
 *   - videoProcessingRoutes.js → Deprecado (migrado a v1/videoProcessingRoutes.js)
 *   - HealthRoutes.js → Deprecado (migrado a v1/healthRoutes.js)
 *
 * NO se importa ni se usa en la configuración actual del servidor.
 */

export default {};