/**
 * courseRoutes.js (Legacy)
 *
 * @deprecated Este archivo está DEPRECADO. Usar las rutas hexagonales en:
 *   - src/interfaces/http/routes/v1/courseRoutes.js
 *   - CourseController + CourseDomainService (inyección de dependencias)
 *
 * VIOLACIONES CORREGIDAS:
 *   - DIP: Importaba SupabaseService directamente (infraestructura en capa de interfaz)
 *   - SRP: Contenía SQL queries inline en los handlers de ruta
 *   - SQL Injection: Interpolación directa de userId en queries SQL
 *
 * Los endpoints han sido migrados a:
 *   - GET /creator/:userId/with-submissions → /api/v1/courses/creator-id/:userId/with-submissions
 *   - GET /:courseId/submissions → /api/v1/submissions/course/:courseId
 *
 * Este archivo se mantiene únicamente como referencia de la migración.
 * NO se importa ni se monta en el servidor.
 */

import { Router } from 'express';

const router = Router();

// All functionality has been migrated to hexagonal v1 routes.
// See: src/interfaces/http/routes/v1/courseRoutes.js
// See: src/interfaces/http/routes/v1/submissionRoutes.js

export default router;

