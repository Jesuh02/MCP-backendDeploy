/**
 * AppDistributionDomainService — Caso de uso para distribución de la app (APK/deep links).
 *
 * Migrado desde index.legacy.js: GET /app-link, GET /download-apk
 *
 * Principios:
 *   - SRP: gestiona únicamente la lógica de distribución de la app
 *   - DIP: depende de puertos abstractos (fileSystem), no implementación directa
 *   - OCP: agregar nuevas plataformas (iOS, Web) no requiere modificar este servicio
 */

import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';
import fs from 'fs';
import path from 'path';

export class AppDistributionDomainService {
    constructor() {
        this.apkPath = path.resolve(process.cwd(), 'app-debug.apk');
    }

    /**
     * Genera la información necesaria para el smart link handler.
     * Detecta si la app está instalada y redirige o prepara descarga del APK.
     * @param {{ userId: string, action?: string, baseUrl: string }} params
     * @returns {Result<{ deepLink: string, apkUrl: string, html: string }>}
     */
    generateAppLink({ userId, action = 'chat', baseUrl }) {
        if (!userId) {
            return Result.fail(new ValidationError('userId es requerido'));
        }

        const deepLink = `YisusCompany://${action}?userId=${userId}`;
        const apkUrl = `${baseUrl}/download-apk`;

        const html = this._buildAppLinkHTML({ deepLink, apkUrl });

        return Result.ok({ deepLink, apkUrl, html });
    }

    /**
     * Verifica si el APK existe y retorna su path.
     * @returns {Result<{ path: string, exists: boolean }>}
     */
    getApkInfo() {
        const exists = fs.existsSync(this.apkPath);

        if (!exists) {
            return Result.fail(new NotFoundError('APK', this.apkPath));
        }

        return Result.ok({ path: this.apkPath, exists: true });
    }

    /**
     * Genera la página HTML de detección de app / descarga de APK.
     * @private
     */
    _buildAppLinkHTML({ deepLink, apkUrl }) {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Abriendo YisusCompany...</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .container { text-align: center; padding: 40px; max-width: 500px; }
        .logo { font-size: 64px; margin-bottom: 20px; }
        h1 { font-size: 32px; margin-bottom: 16px; font-weight: 700; }
        p { font-size: 18px; opacity: 0.9; margin-bottom: 30px; }
        .spinner {
            border: 4px solid rgba(255,255,255,0.3);
            border-top: 4px solid white;
            border-radius: 50%;
            width: 50px; height: 50px;
            animation: spin 1s linear infinite;
            margin: 30px auto;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .btn {
            display: inline-block; background: white; color: #667eea;
            padding: 16px 32px; border-radius: 12px; text-decoration: none;
            font-weight: 600; font-size: 16px; margin-top: 20px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: transform 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .hidden { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <div id="opening">
            <div class="logo">📱</div>
            <h1>Abriendo CourseV...</h1>
            <p>Redirigiendo a la aplicación</p>
            <div class="spinner"></div>
        </div>
        <div id="download" class="hidden">
            <div class="logo">📥</div>
            <h1>Descarga CourseV</h1>
            <p>La aplicación se descargará automáticamente en unos segundos...</p>
            <a href="${apkUrl}" class="btn">Descargar APK</a>
        </div>
    </div>
    <script>
        var appOpened = false;
        var deepLink = "${deepLink}";
        var apkUrl = "${apkUrl}";

        document.addEventListener('visibilitychange', function() {
            if (document.hidden) appOpened = true;
        });

        window.location.href = deepLink;

        setTimeout(function() {
            if (!appOpened && !document.hidden) {
                document.getElementById('opening').classList.add('hidden');
                document.getElementById('download').classList.remove('hidden');
                setTimeout(function() { window.location.href = apkUrl; }, 3000);
            }
        }, 2000);

        window.addEventListener('focus', function() {
            setTimeout(function() {
                if (!document.hidden) {
                    document.getElementById('opening').classList.add('hidden');
                    document.getElementById('download').classList.remove('hidden');
                }
            }, 500);
        });
    </script>
</body>
</html>`;
    }

    /**
     * Genera HTML de "APK no disponible".
     * @returns {string}
     */
    static getApkNotFoundHTML() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>APK no disponible</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; display: flex; align-items: center;
            justify-content: center; color: white; text-align: center; padding: 20px;
        }
        .container { max-width: 500px; }
        h1 { font-size: 32px; margin-bottom: 16px; }
        p { font-size: 18px; opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <h1>APK no disponible</h1>
        <p>El archivo app-debug.apk no se encuentra en el servidor.</p>
        <p style="margin-top: 20px; font-size: 14px;">Contacta al administrador para obtener el APK.</p>
    </div>
</body>
</html>`;
    }
}

export default AppDistributionDomainService;


