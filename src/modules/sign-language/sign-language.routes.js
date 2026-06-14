/**
 * sign-language.routes.js — Tres pipelines complementarias de señas.
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
 *   C) SMART AUTO-FRAME (recomendado): el frontend envía cada frame de
 *      la cámara y el servidor decide automáticamente, basándose en el
 *      MOVIMIENTO entre frames, si debe clasificar una letra/número
 *      (cuando la mano lleva ~1 s quieta) o reconocer una palabra/frase
 *      (cuando hubo movimiento sostenido). Endpoint:
 *      /session/:id/auto-frame. Internamente combina (A) + (B) y mantiene
 *      el state machine en `smart-recognizer.js`.
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
import { signLanguageRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';
import {
    pushLetter,
    pushWord,
    finalizeSession,
    deleteSession,
    getSessionDraft,
    composePhrase,
} from './phrase-composer.js';
import { recognizeSignClip, recognizeSignStream, recognizeSignTimeline } from './sign-language-vlm.js';
import {
    HF_MODEL_ID,
    getLetterClassifier,
    classifyLetter,
} from './letter-classifier.js';
import { ingestFrame as smartIngestFrame, resetRecognizerState } from './smart-recognizer.js';

export function signLanguageRoutes() {
    const router = Router();

    router.get('/health', async (_req, res) => {
        if (process.env.SIGN_LANGUAGE_DISABLED === 'true') {
            return res.json({ success: true, data: { ready: false, reason: 'disabled' } });
        }
        try {
            await getLetterClassifier();
            res.json({
                success: true,
                data: {
                    ready: true,
                    model: HF_MODEL_ID,
                    capabilities: {
                        letterClassification: true,
                        phraseComposition: true,
                        americanSignLanguage: true,
                        englishOutput: true,
                        colombianSignLanguage: true,
                        spanishOutput: true,
                        supportedProfiles: ['asl', 'lsc'],
                        defaultProfile: getSignLanguageProfile(),
                        clipRecognition: Boolean(process.env.OPENROUTER_API_KEY),
                        aslLexiconNormalization: Boolean(process.env.OPENROUTER_API_KEY),
                        lscLexiconNormalization: Boolean(process.env.OPENROUTER_API_KEY),
                        sentenceRecognition: Boolean(process.env.OPENROUTER_API_KEY),
                        twoHandedGestures: Boolean(process.env.OPENROUTER_API_KEY),
                        motionIntent: Boolean(process.env.OPENROUTER_API_KEY),
                        smartAutoFrame: Boolean(process.env.OPENROUTER_API_KEY),
                        streamRecognition: Boolean(process.env.OPENROUTER_API_KEY),
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
            const result = await classifyLetter(decoded);
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
            const result = await classifyLetter(decoded);
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
                language: getSignLanguageProfile(req.body),
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
        resetRecognizerState(req.params.id);
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
                previousText: typeof req.body?.previousText === 'string' ? req.body.previousText : undefined,
                mode: ['static', 'dynamic', 'sentence'].includes(req.body?.mode) ? req.body.mode : 'dynamic',
                model: typeof req.body?.model === 'string' ? req.body.model : undefined,
                language: getSignLanguageProfile(req.body),
            });
            return res.json({ success: true, data: result });
        } catch (err) {
            return handleVlmError(err, res);
        }
    });

    /**
     * Reconocimiento sin estado para videos completos ya muestreados a frames.
     *
     * Body: {
     *   frames: string[] | { imageBase64: string, atMs?: number }[],
     *   timestampsMs?: number[],
     *   frameIntervalMs?: number,
     *   segmenter?: "motion"|"sliding"|"timeline",
     *   includeStatic?: boolean,
     *   minConfidence?: number,
     *   vocabulary?: string[],
     *   strictVocabulary?: boolean,
     *   uniqueVocabulary?: boolean,
     *   timelineWindowMs?: number,
     *   timelineMaxFrames?: number,
     *   context?: string,
     *   model?: string,
     * }
     */
    router.post('/recognize-stream', signLanguageRateLimiter, async (req, res) => {
        const guard = guardEnabled(res);
        if (guard) return guard;

        const decoded = decodeStreamFrames(req.body?.frames, res);
        if (!decoded) return;

        const bodyTimestamps = Array.isArray(req.body?.timestampsMs)
            ? req.body.timestampsMs.map((v) => Number(v))
            : null;
        const timestampsMs = bodyTimestamps && bodyTimestamps.length === decoded.frames.length
            ? bodyTimestamps
            : decoded.timestampsMs;

        try {
            const streamOpts = {
                timestampsMs,
                frameIntervalMs: Number(req.body?.frameIntervalMs),
                segmenter: ['sliding', 'timeline'].includes(req.body?.segmenter) ? req.body.segmenter : 'motion',
                includeStatic: req.body?.includeStatic !== false,
                minConfidence: Number.isFinite(Number(req.body?.minConfidence))
                    ? Number(req.body.minConfidence)
                    : undefined,
                vocabulary: Array.isArray(req.body?.vocabulary)
                    ? req.body.vocabulary.filter((x) => typeof x === 'string').slice(0, 80)
                    : undefined,
                strictVocabulary: req.body?.strictVocabulary !== false,
                uniqueVocabulary: Boolean(req.body?.uniqueVocabulary),
                timelineWindowMs: Number(req.body?.timelineWindowMs),
                timelineMaxFrames: Number(req.body?.timelineMaxFrames),
                context: typeof req.body?.context === 'string' ? req.body.context.slice(0, 500) : undefined,
                language: getSignLanguageProfile(req.body),
                model: typeof req.body?.model === 'string' ? req.body.model : undefined,
                timeoutMs: Number(req.body?.timeoutMs),
                concurrency: Number(req.body?.concurrency),
                windowSize: Number(req.body?.windowSize),
                stride: Number(req.body?.stride),
            };
            const result = streamOpts.segmenter === 'timeline'
                ? await recognizeSignTimeline(decoded.frames, streamOpts)
                : await recognizeSignStream(decoded.frames, streamOpts);
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
            : 0.6;

        try {
            // Continuidad conversacional: si el cliente no pasa contexto,
            // usamos el draft acumulado de la sesión como `previousText`
            // para que el VLM desambigüe mejor en una conversación larga.
            const sessionDraft = getSessionDraft(sessionId)?.draft || '';
            const result = await recognizeSignClip(frames, {
                context: typeof req.body?.context === 'string' ? req.body.context : undefined,
                previousText: typeof req.body?.previousText === 'string'
                    ? req.body.previousText
                    : (sessionDraft || undefined),
                mode: ['static', 'dynamic', 'sentence'].includes(req.body?.mode) ? req.body.mode : 'dynamic',
                model: typeof req.body?.model === 'string' ? req.body.model : undefined,
                language: getSignLanguageProfile(req.body),
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
     * SMART AUTO-FRAME — el endpoint recomendado para uso en producción.
     *
     * Recibe UN frame a la vez (la cámara del frontend a 8-10 fps) y deja
     * que el servidor decida qué hacer según el movimiento del usuario:
     *   - mano quieta ≈ 1 segundo  →  detecta LETRA o NÚMERO (ONNX → VLM).
     *   - manos en movimiento sostenido seguido de pausa  →  detecta
     *     PALABRA, FRASE u ORACIÓN ASL/inglés con el VLM sobre el clip acumulado
     *     (LSC sigue disponible pasando language="lsc").
     *
     * El servidor mantiene el buffer de frames y la máquina de estados por
     * sesión: el frontend NO tiene que decidir cuándo cambiar de modo ni
     * cuántos frames enviar a un clip — solo "stream all frames".
     *
     * Body: {
     *   imageBase64: string,
     *   minLetterConfidence?: number,   // default 0.55 (ONNX)
     *   minPhraseConfidence?: number,   // default 0.6  (VLM)
     *   stillDurationMs?: number,       // default 1000
     *   allowVlmLetterFallback?: boolean, // default true (números / letras raras)
     *   capturedAtMs?: number,          // Date.now() del frame en el navegador
     *   frameSeq?: number,              // contador monotónico para descartar frames tardíos
     *   context?: string,
     *   model?: string,
     *   debug?: boolean,
     * }
     *
     * Response: {
     *   event: null | { source, kind, text, confidence, alternatives, handedness, motion, nonManual, reasoning? },
     *   pushed: boolean,
     *   motion: number,    // [0,1] motion score del frame actual
     *   state: 'idle'|'moving'|'settling'|'still',
     *   draft: string,     // borrador acumulado de la sesión
     *   eventCount: number,
     *   debug?: {...},
     * }
     */
    router.post('/session/:id/auto-frame', signLanguageRateLimiter, async (req, res) => {
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

        try {
            const result = await smartIngestFrame(sessionId, decoded, {
                context: typeof req.body?.context === 'string' ? req.body.context.slice(0, 300) : undefined,
                model: typeof req.body?.model === 'string' ? req.body.model : undefined,
                language: getSignLanguageProfile(req.body),
                minLetterConfidence: Number(req.body?.minLetterConfidence),
                minPhraseConfidence: Number(req.body?.minPhraseConfidence),
                stillDurationMs: Number(req.body?.stillDurationMs),
                capturedAtMs: Number(req.body?.capturedAtMs),
                frameSeq: Number(req.body?.frameSeq),
                allowVlmLetterFallback: req.body?.allowVlmLetterFallback !== false,
                debug: Boolean(req.body?.debug),
            });
            return res.json({ success: true, data: result });
        } catch (err) {
            const msg = err?.message || String(err);
            console.error('[SignLanguage] auto-frame falló:', msg);
            // Errores del classifier ONNX (HF no configurado) o del VLM
            // bajan al frontend con códigos consistentes.
            if (/Falta .*\.(json|onnx)|SIGN_LANGUAGE_HF_REPO/.test(msg)) {
                return res.status(503).json({
                    success: false,
                    error: { code: 'HF_NOT_CONFIGURED', message: msg, statusCode: 503 },
                });
            }
            if (err?.code === 'VLM_NOT_CONFIGURED') {
                return res.status(503).json({
                    success: false,
                    error: { code: 'VLM_NOT_CONFIGURED', message: msg, statusCode: 503 },
                });
            }
            return res.status(500).json({
                success: false,
                error: {
                    code: 'AUTO_FRAME_FAILED',
                    message: 'Falló el procesamiento inteligente del frame.',
                    statusCode: 500,
                },
            });
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
                language: getSignLanguageProfile(req.body),
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

function getSignLanguageProfile(body = {}) {
    const raw = String(
        body?.language ||
        body?.profile ||
        process.env.SIGN_LANGUAGE_PROFILE ||
        process.env.SIGN_LANGUAGE_VARIANT ||
        process.env.SIGN_LANGUAGE_LANGUAGE ||
        'asl',
    ).trim().toLowerCase();
    if (['lsc', 'es', 'es-co', 'spanish', 'colombian', 'colombia', 'lengua-de-senas-colombiana'].includes(raw)) {
        return 'lsc';
    }
    return 'asl';
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
// classifyImage extraída a letter-classifier.js (`classifyLetter`).

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
function decodeClipFrames(frames, res, maxFrames = 12) {
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
    if (frames.length > maxFrames) {
        res.status(400).json({
            success: false,
            error: {
                code: 'CLIP_TOO_LONG',
                message: `Máximo ${maxFrames} frames por petición.`,
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

function decodeStreamFrames(frames, res, maxFrames = 360) {
    if (!Array.isArray(frames) || frames.length === 0) {
        res.status(400).json({
            success: false,
            error: {
                code: 'INVALID_STREAM',
                message: 'Se requiere "frames" como arreglo de imagenes base64.',
                statusCode: 400,
            },
        });
        return null;
    }
    if (frames.length > maxFrames) {
        res.status(400).json({
            success: false,
            error: {
                code: 'STREAM_TOO_LONG',
                message: `Maximo ${maxFrames} frames por peticion de stream.`,
                statusCode: 400,
            },
        });
        return null;
    }

    const decoded = [];
    const timestampsMs = [];
    let hasAnyTimestamp = false;
    let hasAllTimestamps = true;

    for (const item of frames) {
        const raw = typeof item === 'string'
            ? item
            : item?.imageBase64 || item?.base64 || item?.dataUrl || item?.image;

        if (typeof raw !== 'string' || raw.length < 100) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_STREAM',
                    message: 'Cada frame debe ser una imagen base64 valida.',
                    statusCode: 400,
                },
            });
            return null;
        }

        const t = typeof item === 'object' && item
            ? Number(item.atMs ?? item.timestampMs ?? item.timeMs)
            : NaN;
        if (Number.isFinite(t)) {
            hasAnyTimestamp = true;
            timestampsMs.push(t);
        } else {
            hasAllTimestamps = false;
            timestampsMs.push(null);
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
                    code: 'INVALID_STREAM',
                    message: 'Un frame del stream no es base64 valido.',
                    statusCode: 400,
                },
            });
            return null;
        }
    }

    return {
        frames: decoded,
        timestampsMs: hasAnyTimestamp && hasAllTimestamps ? timestampsMs : undefined,
    };
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

// detectMime() vive ahora en letter-classifier.js (no se usa directamente
// en este módulo: classifyLetter() y los helpers de motion lo encapsulan).

export default signLanguageRoutes;
