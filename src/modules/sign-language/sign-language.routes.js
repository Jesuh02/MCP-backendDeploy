/**
 * sign-language.routes.js — HuggingFace Inference API proxy.
 *
 * Forwards a base64-encoded camera frame to the HuggingFace Inference API
 * (prithivMLmods/Alphabet-Sign-Language-Detection) and returns the top prediction.
 * Keeps the HF token on the server (never exposed to the browser).
 *
 * Required env vars:
 *   HF_API_TOKEN  — HuggingFace API token from https://huggingface.co/settings/tokens
 */

import { Router } from 'express';
import { signLanguageRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';

const HF_MODEL = 'prithivMLmods/Alphabet-Sign-Language-Detection';
const HF_INFERENCE_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

export function signLanguageRoutes() {
    const router = Router();

    router.post('/infer', signLanguageRateLimiter, async (req, res) => {
        const apiToken = process.env.HF_API_TOKEN;

        if (!apiToken) {
            return res.status(503).json({
                success: false,
                error: {
                    code: 'HF_NOT_CONFIGURED',
                    message: 'HF_API_TOKEN no está configurado en el servidor.',
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

        // Strip the data URL prefix if present ("data:image/jpeg;base64,...")
        const cleanBase64 = imageBase64.includes(',')
            ? imageBase64.split(',', 2)[1]
            : imageBase64;

        const imageBuffer = Buffer.from(cleanBase64, 'base64');

        try {
            const hfRes = await fetch(HF_INFERENCE_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/octet-stream',
                },
                body: imageBuffer,
            });

            if (!hfRes.ok) {
                const errBody = await hfRes.text().catch(() => '');
                console.warn(`[SignLanguage] HuggingFace ${hfRes.status}: ${errBody.slice(0, 200)}`);

                // 503 means the model is still loading (cold start)
                if (hfRes.status === 503) {
                    return res.status(503).json({
                        success: false,
                        error: {
                            code: 'HF_MODEL_LOADING',
                            message: 'El modelo está cargando, reintenta en unos segundos.',
                            statusCode: 503,
                        },
                    });
                }

                return res.status(502).json({
                    success: false,
                    error: {
                        code: 'HF_UPSTREAM_ERROR',
                        message: `HuggingFace respondió ${hfRes.status}`,
                        statusCode: 502,
                    },
                });
            }

            const data = await hfRes.json();
            // HF image-classification returns: [{label: "A", score: 0.99}, ...]
            const preds = Array.isArray(data) ? data : [];

            if (!preds.length) {
                return res.json({ success: true, data: { detection: null, model: HF_MODEL } });
            }

            const top = preds.reduce((a, b) =>
                (a?.score ?? 0) > (b?.score ?? 0) ? a : b,
            );

            return res.json({
                success: true,
                data: {
                    detection: {
                        label: String(top.label ?? '').toUpperCase(),
                        confidence: Number(top.score) || 0,
                    },
                    model: HF_MODEL,
                },
            });
        } catch (err) {
            console.error('[SignLanguage] Error llamando a HuggingFace:', err?.message || err);
            return res.status(500).json({
                success: false,
                error: {
                    code: 'HF_REQUEST_FAILED',
                    message: 'No se pudo contactar al servicio de inferencia.',
                    statusCode: 500,
                },
            });
        }
    });

    return router;
}

export default signLanguageRoutes;
