/**
 * notificationRoutes.js (Legacy)
 *
 * @deprecated Este archivo está DEPRECADO. Usar las rutas hexagonales en:
 *   - src/interfaces/http/routes/v1/notificationRoutes.js
 *   - NotificationController + NotificationDomainService (inyección de dependencias)
 *
 * VIOLACIONES CORREGIDAS:
 *   - DIP: Importaba NotificationService.getInstance() directamente (singleton de infraestructura)
 *   - SRP: Contenía lógica de notificación en los handlers de ruta
 *
 * Los endpoints legacy de notificación (/notify-chat-response, /send-push-notification,
 * /notify-course-creation) ahora se manejan en server.js delegando al container.
 *
 * Este archivo se mantiene únicamente como referencia de la migración.
 * NO se importa ni se monta en el servidor.
 */

import { Router } from 'express';

const router = Router();

// All functionality has been migrated to hexagonal v1 routes.
// See: src/interfaces/http/routes/v1/notificationRoutes.js

export default router;