/**
 * sign-language.routes.js — Inferencia local con Transformers.js (ONNX).
 *
 * Modelo: prithivMLmods/Alphabet-Sign-Language-Detection (SigLIP fine-tuned).
 * Como ese modelo NO está desplegado en ningún HuggingFace Inference Provider
 * (el endpoint api-inference.huggingface.co fue retirado y el router devuelve
 * 410 Gone), lo servimos in-process con `@huggingface/transformers` sobre
 * onnxruntime-node.
 *
 * Preparación (una sola vez):
 *   python scripts/convert_sign_language_to_onnx.py
 * Esto genera models/sign-language/{config.json, preprocessor_config.json,
 * onnx/model.onnx}.
 *
 * Variables de entorno opcionales:
 *   SIGN_LANGUAGE_MODEL_DIR  — ruta absoluta al directorio del modelo
 *                              (default: <repo>/models/sign-language)
 *   SIGN_LANGUAGE_DISABLED   — "true" para devolver 503 sin intentar cargar
 */

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signLanguageRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HF_MODEL_ID = 'prithivMLmods/Alphabet-Sign-Language-Detection';
const DEFAULT_MODEL_DIR = path.resolve(__dirname, '../../../models/sign-language');
const MODEL_DIR = process.env.SIGN_LANGUAGE_MODEL_DIR || DEFAULT_MODEL_DIR;

// Singleton del pipeline: se carga una vez y se reutiliza.
let classifierPromise = null;
let loadError = null;

async function getClassifier() {
    if (loadError) throw loadError;
    if (classifierPromise) return classifierPromise;

    classifierPromise = (async () => {
        const required = ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'];
        for (const rel of required) {
            const p = path.join(MODEL_DIR, rel);
            if (!fs.existsSync(p)) {
                throw new Error(
                    `Falta ${rel} en ${MODEL_DIR}. Ejecuta: python scripts/convert_sign_language_to_onnx.py`,
                );
            }
        }

        const { pipeline, env } = await import('@huggingface/transformers');

        // Forzar uso de archivos locales (sin descargas al hub).
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = path.dirname(MODEL_DIR);

        const modelName = path.basename(MODEL_DIR); // "sign-language"
        console.log(`[SignLanguage] Cargando pipeline desde ${MODEL_DIR} ...`);
        const t0 = Date.now();
        const pipe = await pipeline('image-classification', modelName, {
            dtype: 'fp32',
        });
        console.log(`[SignLanguage] Pipeline listo en ${Date.now() - t0} ms`);
        return pipe;
    })().catch((err) => {
        loadError = err;
        classifierPromise = null;
        throw err;
    });

    return classifierPromise;
}

export function signLanguageRoutes() {
    const router = Router();

    router.get('/health', async (_req, res) => {
        if (process.env.SIGN_LANGUAGE_DISABLED === 'true') {
            return res.json({ success: true, data: { ready: false, reason: 'disabled' } });
        }
        try {
            await getClassifier();
            res.json({ success: true, data: { ready: true, model: HF_MODEL_ID } });
        } catch (err) {
            res.json({
                success: true,
                data: { ready: false, reason: err?.message?.slice(0, 200) || 'load_failed' },
            });
        }
    });

    router.post('/infer', signLanguageRateLimiter, async (req, res) => {
        if (process.env.SIGN_LANGUAGE_DISABLED === 'true') {
            return res.status(503).json({
                success: false,
                error: {
                    code: 'SIGN_LANGUAGE_DISABLED',
                    message: 'El servicio de detección de señas está deshabilitado.',
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

        const cleanBase64 = imageBase64.includes(',')
            ? imageBase64.split(',', 2)[1]
            : imageBase64;

        let imageBuffer;
        try {
            imageBuffer = Buffer.from(cleanBase64, 'base64');
            if (imageBuffer.length < 100) throw new Error('payload muy corto');
        } catch {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_IMAGE',
                    message: 'imageBase64 no es un buffer válido.',
                    statusCode: 400,
                },
            });
        }

        try {
            const classifier = await getClassifier();
            const { RawImage } = await import('@huggingface/transformers');

            const mime = detectMime(imageBuffer);
            const blob = new Blob([imageBuffer], { type: mime });
            const image = await RawImage.fromBlob(blob);

            const preds = await classifier(image, { top_k: 3 });

            if (!Array.isArray(preds) || preds.length === 0) {
                return res.json({
                    success: true,
                    data: { detection: null, model: HF_MODEL_ID },
                });
            }

            const top = preds[0];
            return res.json({
                success: true,
                data: {
                    detection: {
                        label: String(top.label ?? '').toUpperCase(),
                        confidence: Number(top.score) || 0,
                    },
                    alternatives: preds.slice(1).map((p) => ({
                        label: String(p.label ?? '').toUpperCase(),
                        confidence: Number(p.score) || 0,
                    })),
                    model: HF_MODEL_ID,
                },
            });
        } catch (err) {
            const msg = err?.message || String(err);
            console.error('[SignLanguage] Error en inferencia local:', msg);

            // Si los artefactos no están, devolver el mismo código que usaba la
            // versión antigua para que el frontend active modo simulación.
            if (/Falta .*\.(json|onnx)/.test(msg)) {
                return res.status(503).json({
                    success: false,
                    error: {
                        code: 'HF_NOT_CONFIGURED',
                        message: msg,
                        statusCode: 503,
                    },
                });
            }

            return res.status(500).json({
                success: false,
                error: {
                    code: 'SIGN_LANGUAGE_FAILED',
                    message: 'Falló la inferencia local del modelo.',
                    statusCode: 500,
                },
            });
        }
    });

    return router;
}

/**
 * Detecta el mime-type a partir de los magic bytes (JPEG / PNG / WebP).
 */
function detectMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    ) {
        return 'image/png';
    }
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
        return 'image/webp';
    }
    return 'image/jpeg';
}

export default signLanguageRoutes;
