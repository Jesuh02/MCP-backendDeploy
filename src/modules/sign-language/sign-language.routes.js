/**
 * sign-language.routes.js — Dos pipelines complementarias de señas.
 *
 *   A) ALFABETO (estático, frame-a-frame): clasificación local con
 *      Transformers.js sobre ONNX usando prithivMLmods/Alphabet-Sign-
 *      Language-Detection. Útil para deletreo (nombres propios) o cuando
 *      el usuario hace una sola letra. Endpoints: /infer y
 *      /session/:id/frame.
 *
 *   B) PALABRAS Y FRASES (dinámico, clip multi-frame): reconocimiento
 *      con un Vision-Language Model (VLM) vía OpenRouter (Qwen2.5-VL /
 *      Gemini-Flash, ver `sign-language-vlm.js`). Esta es la pieza que
 *      permite detectar "hola", "gracias", "¿cómo estás?", etc., que un
 *      clasificador de imagen estática NUNCA puede reconocer porque son
 *      gestos en movimiento. Endpoints: /recognize-clip y
 *      /session/:id/clip.
 *
 * La sesión (`phrase-composer.js`) acepta ambos tipos de evento y los
 * intercala en el draft final, que luego pasa por el LLM para
 * normalizar puntuación, tildes y mayúsculas.
 *
 * Carga de pesos (dos modos, en orden de prioridad):
 *   1. Local: SIGN_LANGUAGE_MODEL_DIR (o <repo>/models/sign-language) con
 *      {config.json, preprocessor_config.json, onnx/model.onnx}.
 *   2. Remoto: SIGN_LANGUAGE_HF_REPO = "tu_usuario/Alphabet-Sign-Language-ONNX"
 *      Transformers.js descarga del Hub y cachea en SIGN_LANGUAGE_CACHE_DIR
 *      (default /tmp/transformers-cache). Si el repo es privado se usa
 *      HF_API_TOKEN.
 *
 * Generar los artefactos:
 *   python scripts/convert_sign_language_to_onnx.py
 *   python scripts/upload_sign_language_to_hf.py    # opcional, sube al Hub
 *
 * Otras variables:
 *   SIGN_LANGUAGE_DISABLED  "true" para devolver 503 sin intentar cargar
 */

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signLanguageRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';
import {
    pushLetter,
    pushWord,
    finalizeSession,
    deleteSession,
    getSessionDraft,
    composePhrase,
} from './phrase-composer.js';
import { recognizeSignClip } from './sign-language-vlm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HF_MODEL_ID = 'prithivMLmods/Alphabet-Sign-Language-Detection';
const DEFAULT_MODEL_DIR = path.resolve(__dirname, '../../../models/sign-language');
const MODEL_DIR = process.env.SIGN_LANGUAGE_MODEL_DIR || DEFAULT_MODEL_DIR;
const HF_REPO = (process.env.SIGN_LANGUAGE_HF_REPO || '').trim();
const CACHE_DIR = process.env.SIGN_LANGUAGE_CACHE_DIR || '/tmp/transformers-cache';

// Singleton del pipeline: se carga una vez y se reutiliza.
let classifierPromise = null;
let loadError = null;

async function getClassifier() {
    if (loadError) throw loadError;
    if (classifierPromise) return classifierPromise;

    classifierPromise = (async () => {
        const hasLocal = ['config.json', 'preprocessor_config.json', 'onnx/model.onnx']
            .every((rel) => fs.existsSync(path.join(MODEL_DIR, rel)));

        if (!hasLocal && !HF_REPO) {
            throw new Error(
                `Falta config.json en ${MODEL_DIR} y SIGN_LANGUAGE_HF_REPO no está definido. ` +
                `Sube el ONNX a un repo HuggingFace tuyo y exporta ` +
                `SIGN_LANGUAGE_HF_REPO=tu_usuario/Alphabet-Sign-Language-ONNX, o bien ` +
                `bundlea los pesos en ${MODEL_DIR}.`,
            );
        }

        const { pipeline, env } = await import('@huggingface/transformers');

        if (hasLocal) {
            env.allowRemoteModels = false;
            env.allowLocalModels = true;
            env.localModelPath = path.dirname(MODEL_DIR);
            const modelName = path.basename(MODEL_DIR); // "sign-language"
            console.log(`[SignLanguage] Cargando pipeline LOCAL desde ${MODEL_DIR} ...`);
            const t0 = Date.now();
            const pipe = await pipeline('image-classification', modelName, { dtype: 'fp32' });
            console.log(`[SignLanguage] Pipeline listo en ${Date.now() - t0} ms`);
            return pipe;
        }

        // --- Modo remoto: descargar desde el Hub ---
        try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        } catch { /* ignore */ }

        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.cacheDir = CACHE_DIR;
        env.useFSCache = true;

        // Transformers.js lee process.env.HF_TOKEN para repos privados.
        if (process.env.HF_API_TOKEN && !process.env.HF_TOKEN) {
            process.env.HF_TOKEN = process.env.HF_API_TOKEN;
        }

        console.log(`[SignLanguage] Cargando pipeline REMOTO desde ${HF_REPO} (cache: ${CACHE_DIR}) ...`);
        const t0 = Date.now();
        const pipe = await pipeline('image-classification', HF_REPO, { dtype: 'fp32' });
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
            res.json({
                success: true,
                data: {
                    ready: true,
                    model: HF_MODEL_ID,
                    capabilities: {
                        letterClassification: true,
                        phraseComposition: true,
                        clipRecognition: Boolean(process.env.OPENROUTER_API_KEY),
                        twoHandedGestures: Boolean(process.env.OPENROUTER_API_KEY),
                        motionIntent: Boolean(process.env.OPENROUTER_API_KEY),
                    },
                },
            });
        } catch (err) {
            res.json({
                success: true,
                data: { ready: false, reason: err?.message?.slice(0, 200) || 'load_failed' },
            });
        }
    });

    router.post('/infer', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const decoded = decodeBase64Image(req.body?.imageBase64, res);
        if (!decoded) return;

        try {
            const result = await classifyImage(decoded);
            if (!result) return res.json({ success: true, data: { detection: null, model: HF_MODEL_ID } });
            return res.json({ success: true, data: { ...result, model: HF_MODEL_ID } });
        } catch (err) {
            return handleClassifierError(err, res);
        }
    });

    /**
     * Empuja un frame a una sesión de composición. Devuelve la detección
     * cruda + el draft acumulado (letras con espacios implícitos por gaps).
     * Body: { imageBase64, sessionId, minConfidence? }
     */
    router.post('/session/:id/frame', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const sessionId = String(req.params.id || '').trim();
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_SESSION', message: 'sessionId requerido.', statusCode: 400 },
            });
        }

        const decoded = decodeBase64Image(req.body?.imageBase64, res);
        if (!decoded) return;

        const minConfidence = Number.isFinite(Number(req.body?.minConfidence))
            ? Number(req.body.minConfidence)
            : 0.5;

        try {
            const result = await classifyImage(decoded);
            const top = result?.detection ?? null;
            let pushed = false;
            if (top && top.confidence >= minConfidence) {
                pushLetter(sessionId, top);
                pushed = true;
            }
            const { draft, eventCount } = getSessionDraft(sessionId);
            return res.json({
                success: true,
                data: {
                    detection: top,
                    alternatives: result?.alternatives ?? [],
                    draft,
                    eventCount,
                    pushed,
                    model: HF_MODEL_ID,
                },
            });
        } catch (err) {
            return handleClassifierError(err, res);
        }
    });

    /**
     * Cierra la sesión y devuelve la frase compuesta (LLM cuando esté
     * disponible, fallback heurístico si no).
     * Body opcional: { useLLM?: boolean, context?: string, keep?: boolean }
     */
    router.post('/session/:id/finalize', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const sessionId = String(req.params.id || '').trim();
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_SESSION', message: 'sessionId requerido.', statusCode: 400 },
            });
        }

        try {
            const composed = await finalizeSession(sessionId, {
                useLLM: req.body?.useLLM !== false,
                context: typeof req.body?.context === 'string' ? req.body.context.slice(0, 500) : undefined,
                keep: Boolean(req.body?.keep),
            });
            return res.json({ success: true, data: composed });
        } catch (err) {
            console.error('[SignLanguage] finalize falló:', err?.message || err);
            return res.status(500).json({
                success: false,
                error: { code: 'COMPOSE_FAILED', message: 'No se pudo componer la frase.', statusCode: 500 },
            });
        }
    });

    router.delete('/session/:id', (req, res) => {
        deleteSession(req.params.id);
        return res.json({ success: true, data: { cleared: true } });
    });

    /**
     * Reconocimiento de señas DINÁMICAS (palabras/frases) a partir de un
     * clip de frames. Sin estado: útil para inferencia puntual.
     * Body: {
     *   frames: string[],        // base64 (con o sin prefijo data:) de 1-12 frames
     *   context?: string,        // contexto previo opcional
     *   model?: string,          // override del modelo VLM
     * }
     */
    router.post('/recognize-clip', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const frames = decodeClipFrames(req.body?.frames, res);
        if (!frames) return;

        try {
            const result = await recognizeSignClip(frames, {
                context: typeof req.body?.context === 'string' ? req.body.context : undefined,
                model: typeof req.body?.model === 'string' ? req.body.model : undefined,
            });
            return res.json({ success: true, data: result });
        } catch (err) {
            return handleVlmError(err, res);
        }
    });

    /**
     * Empuja un clip a la sesión: el VLM lo reconoce como palabra/frase
     * (o letra si solo hay deletreo) y se añade al draft acumulado.
     * Body: {
     *   frames: string[],
     *   minConfidence?: number,   // default 0.4
     *   context?: string,
     *   model?: string,
     * }
     */
    router.post('/session/:id/clip', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const sessionId = String(req.params.id || '').trim();
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_SESSION', message: 'sessionId requerido.', statusCode: 400 },
            });
        }

        const frames = decodeClipFrames(req.body?.frames, res);
        if (!frames) return;

        const minConfidence = Number.isFinite(Number(req.body?.minConfidence))
            ? Number(req.body.minConfidence)
            : 0.4;

        try {
            const result = await recognizeSignClip(frames, {
                context: typeof req.body?.context === 'string' ? req.body.context : undefined,
                model: typeof req.body?.model === 'string' ? req.body.model : undefined,
            });
            let pushed = false;
            if (result && result.text && result.kind !== 'unknown' && result.confidence >= minConfidence) {
                // `letter` → carácter único del alfabeto (incluye vocales con tilde
                //   y Ñ si el VLM los devuelve). Va al stream de letras para que
                //   el composer pueda colapsar repeticiones e insertar espacios.
                // `number` (5, 23, 1000) → token indivisible: NO puede colapsarse
                //   con letras adyacentes ni concatenarse cifra a cifra.
                // `word` / `phrase` / `sentence` → siempre tokens indivisibles
                //   con espacio antes/después en el draft.
                const text = String(result.text).trim();
                const isSingleChar = result.kind === 'letter' && Array.from(text).length === 1;
                if (isSingleChar) {
                    pushLetter(sessionId, { label: text, confidence: result.confidence });
                } else {
                    pushWord(sessionId, { text, confidence: result.confidence });
                }
                pushed = true;
            }
            const { draft, eventCount } = getSessionDraft(sessionId);
            return res.json({
                success: true,
                data: {
                    recognition: result,
                    pushed,
                    draft,
                    eventCount,
                },
            });
        } catch (err) {
            return handleVlmError(err, res);
        }
    });

    /**
     * Endpoint sin estado: recibe una secuencia cruda de letras (lo que el
     * frontend acumuló) y devuelve la frase compuesta.
     * Body: { rawSequence: string, context?: string, useLLM?: boolean }
     */
    router.post('/compose', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const rawSequence = String(req.body?.rawSequence ?? '').slice(0, 1000);
        if (!rawSequence.trim()) {
            return res.status(400).json({
                success: false,
                error: { code: 'EMPTY_SEQUENCE', message: 'rawSequence requerido.', statusCode: 400 },
            });
        }

        try {
            const composed = await composePhrase(rawSequence, {
                useLLM: req.body?.useLLM !== false,
                context: typeof req.body?.context === 'string' ? req.body.context.slice(0, 500) : undefined,
            });
            return res.json({ success: true, data: composed });
        } catch (err) {
            console.error('[SignLanguage] compose falló:', err?.message || err);
            return res.status(500).json({
                success: false,
                error: { code: 'COMPOSE_FAILED', message: 'No se pudo componer la frase.', statusCode: 500 },
            });
        }
    });

    return router;
}

/**
 * Verifica el flag global de deshabilitado. Si está activo, responde 503
 * y devuelve la respuesta para que el caller corte (`if (guard) return guard;`).
 */
function guardEnabled(res) {
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
    return null;
}

/**
 * Decodifica y valida un buffer de imagen base64. Si falla, responde 400
 * y devuelve null para que el caller corte.
 * @returns {Buffer|null}
 */
function decodeBase64Image(imageBase64, res) {
    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
        res.status(400).json({
            success: false,
            error: {
                code: 'INVALID_IMAGE',
                message: 'Se requiere "imageBase64" (JPEG/PNG codificado en base64).',
                statusCode: 400,
            },
        });
        return null;
    }
    const cleanBase64 = imageBase64.includes(',')
        ? imageBase64.split(',', 2)[1]
        : imageBase64;
    try {
        const buf = Buffer.from(cleanBase64, 'base64');
        if (buf.length < 100) throw new Error('payload muy corto');
        return buf;
    } catch {
        res.status(400).json({
            success: false,
            error: {
                code: 'INVALID_IMAGE',
                message: 'imageBase64 no es un buffer válido.',
                statusCode: 400,
            },
        });
        return null;
    }
}

/**
 * Clasifica un buffer de imagen. Devuelve `null` si el modelo no produce
 * predicciones, o `{ detection, alternatives }` con top-3.
 */
async function classifyImage(imageBuffer) {
    const classifier = await getClassifier();
    const { RawImage } = await import('@huggingface/transformers');

    const mime = detectMime(imageBuffer);
    const blob = new Blob([imageBuffer], { type: mime });
    const image = await RawImage.fromBlob(blob);

    const preds = await classifier(image, { top_k: 3 });
    if (!Array.isArray(preds) || preds.length === 0) return null;

    const top = preds[0];
    return {
        detection: {
            label: String(top.label ?? '').toUpperCase(),
            confidence: Number(top.score) || 0,
        },
        alternatives: preds.slice(1).map((p) => ({
            label: String(p.label ?? '').toUpperCase(),
            confidence: Number(p.score) || 0,
        })),
    };
}

function handleClassifierError(err, res) {
    const msg = err?.message || String(err);
    console.error('[SignLanguage] Error en inferencia local:', msg);
    if (/Falta .*\.(json|onnx)|SIGN_LANGUAGE_HF_REPO/.test(msg)) {
        return res.status(503).json({
            success: false,
            error: { code: 'HF_NOT_CONFIGURED', message: msg, statusCode: 503 },
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

/**
 * Valida y decodifica un arreglo de frames base64 para el VLM. Responde
 * 400 y devuelve null si la entrada es inválida.
 * @returns {Buffer[]|null}
 */
function decodeClipFrames(frames, res) {
    if (!Array.isArray(frames) || frames.length === 0) {
        res.status(400).json({
            success: false,
            error: {
                code: 'INVALID_CLIP',
                message: 'Se requiere "frames" como arreglo de imágenes base64.',
                statusCode: 400,
            },
        });
        return null;
    }
    if (frames.length > 12) {
        res.status(400).json({
            success: false,
            error: {
                code: 'CLIP_TOO_LONG',
                message: 'Máximo 12 frames por clip.',
                statusCode: 400,
            },
        });
        return null;
    }
    const decoded = [];
    for (const raw of frames) {
        if (typeof raw !== 'string' || raw.length < 100) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_CLIP',
                    message: 'Cada frame debe ser una imagen base64 válida.',
                    statusCode: 400,
                },
            });
            return null;
        }
        const clean = raw.includes(',') ? raw.split(',', 2)[1] : raw;
        try {
            const buf = Buffer.from(clean, 'base64');
            if (buf.length < 100) throw new Error('payload muy corto');
            decoded.push(buf);
        } catch {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_CLIP',
                    message: 'Un frame del clip no es base64 válido.',
                    statusCode: 400,
                },
            });
            return null;
        }
    }
    return decoded;
}

function handleVlmError(err, res) {
    const msg = err?.message || String(err);
    console.error('[SignLanguage][VLM] Error:', msg);
    const status = Number.isFinite(err?.statusCode) ? err.statusCode : 502;
    const code = err?.code || 'VLM_FAILED';
    return res.status(status).json({
        success: false,
        error: {
            code,
            message: status === 503
                ? msg
                : 'No se pudo reconocer la seña con el modelo de visión.',
            statusCode: status,
        },
    });
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
