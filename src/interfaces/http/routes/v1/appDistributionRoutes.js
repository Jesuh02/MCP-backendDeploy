/**
 * appDistributionRoutes — Rutas para distribución de la app (APK / deep links).
 *
 * Migrado desde index.legacy.js: GET /app-link, GET /download-apk
 */

import { Router } from 'express';

export function appDistributionRoutes({ appDistributionController }) {
    const router = Router();

    router.get('/app-link', appDistributionController.getAppLink);
    router.get('/download-apk', appDistributionController.downloadApk);

    return router;
}

export default appDistributionRoutes;
