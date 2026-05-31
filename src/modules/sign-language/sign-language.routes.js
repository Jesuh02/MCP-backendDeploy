/**
 * sign-language.routes.js — Roboflow LSC inference proxy.
 *
 * Forwards a base64-encoded camera frame to the Roboflow Hosted Inference API
 * and returns the top prediction. Keeps the Roboflow API key on the server
 * (never exposed to the browser).
 *
 * Required env vars:
 *   ROBOFLOW_API_KEY  — private API key from https://app.roboflow.com (Settings → API)
 *   ROBOFLOW_MODEL    — model slug + version, e.g. "lsc-oowco/2"  (default)
 */

import { Router } from 'express';
import { signLanguageRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';

const ROBOFLOW_BASE = 'https://serverless.roboflow.com';
const DEFAULT_MODEL = 'lsc-oowco/2';

export function signLanguageRoutes() {
    const router = Router();

    router.post('/infer', signLanguageRateLimiter, async (req, res) => {
        const apiKey = process.env.ROBOFLOW_API_KEY;
        const model = process.env.ROBOFLOW_MODEL || DEFAULT_MODEL;

        if (!apiKey) {
            return res.status(503).json({
                success: false,
                error: {
                    code: 'ROBOFLOW_NOT_CONFIGURED',
                    message: 'ROBOFLOW_API_KEY no está configurado en el servidor.',
                    statusCode: 503,
                },
            });
        }

        const imageBase64 = req.body?.imageBase64;
        if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_IMAGE',
                    message: 'Se requiere "imageBase64" (JPEG/PNG codificado en base64).',
                    statusCode: 400,
                },
            });
        }

        // Allow either raw base64 or a data URL ("data:image/jpeg;base64,...")
        const cleanBase64 = imageBase64.includes(',')
            ? imageBase64.split(',', 2)[1]
            : imageBase64;

        const url = `${ROBOFLOW_BASE}/${model}?api_key=${encodeURIComponent(apiKey)}`;

        try {
            const rfRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: cleanBase64,
            });

            if (!rfRes.ok) {
                const errBody = await rfRes.text().catch(() => '');
                console.warn(`[SignLanguage] Roboflow ${rfRes.status}: ${errBody.slice(0, 200)}`);

                // 404 means the model slug is wrong or the project doesn't exist.
                // Return 503 so the client can show a config-level error.
                if (rfRes.status === 404) {
                    return res.status(503).json({
                        success: false,
                        error: {
                            code: 'ROBOFLOW_MODEL_NOT_FOUND',
                            message: `El modelo "${model}" no existe en Roboflow. Verifica la variable de entorno ROBOFLOW_MODEL.`,
                            statusCode: 503,
                        },
                    });
                }

                return res.status(502).json({
                    success: false,
                    error: {
                        code: 'ROBOFLOW_UPSTREAM_ERROR',
                        message: `Roboflow respondió ${rfRes.status}`,
                        statusCode: 502,
                    },
                });
            }

            const data = await rfRes.json();
            const preds = Array.isArray(data?.predictions) ? data.predictions : [];

            if (!preds.length) {
                return res.json({ success: true, data: { detection: null, model } });
            }

            const top = preds.reduce((a, b) =>
                (a?.confidence ?? 0) > (b?.confidence ?? 0) ? a : b,
            );

            return res.json({
                success: true,
                data: {
                    detection: {
                        label: String(top.class ?? top.label ?? '').toUpperCase(),
                        confidence: Number(top.confidence) || 0,
                    },
                    model,
                },
            });
        } catch (err) {
            console.error('[SignLanguage] Error llamando a Roboflow:', err?.message || err);
            return res.status(500).json({
                success: false,
                error: {
                    code: 'ROBOFLOW_REQUEST_FAILED',
                    message: 'No se pudo contactar al servicio de inferencia.',
                    statusCode: 500,
                },
            });
        }
    });

    return router;
}

export default signLanguageRoutes;
