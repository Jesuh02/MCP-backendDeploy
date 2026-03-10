/**
 * AppDistributionController — Controlador para distribución de la app.
 *
 * Migrado desde index.legacy.js: GET /app-link, GET /download-apk
 *
 * Principios:
 *   - SRP: solo transforma HTTP ↔ dominio
 *   - DIP: depende de AppDistributionDomainService (abstracción)
 */

import { BaseController } from '../../shared/BaseController.js';
import { AppDistributionDomainService } from './app-distribution.service.js';

export class AppDistributionController extends BaseController {
    constructor({ appDistributionService }) {
        super();
        this.service = appDistributionService;
    }

    /**
     * GET /app-link?userId=XXX&action=chat
     * Smart link: detecta si la app está instalada y redirige o descarga APK.
     */
    getAppLink = async(req, res, next) => {
        try {
            const { userId, action } = req.query;

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const result = this.service.generateAppLink({ userId, action, baseUrl });

            if (result.isFail()) {
                return res.status(400).send(result.getError().message);
            }

            const { html } = result.getValue();
            res.send(html);
        } catch (err) {
            next(err);
        }
    };

    /**
     * GET /download-apk
     * Descarga directa del APK de la aplicación.
     */
    downloadApk = async(req, res, next) => {
        try {
            const result = this.service.getApkInfo();

            if (result.isFail()) {
                return res.status(404).send(AppDistributionDomainService.getApkNotFoundHTML());
            }

            const { path: apkPath } = result.getValue();

            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            res.setHeader('Content-Disposition', 'attachment; filename="YisusCompany.apk"');
            res.sendFile(apkPath, (err) => {
                if (err) {
                    console.error('Error enviando APK:', err.message);
                    if (!res.headersSent) {
                        res.status(500).send('Error al descargar el APK');
                    }
                }
            });
        } catch (err) {
            next(err);
        }
    };
}

export default AppDistributionController;

