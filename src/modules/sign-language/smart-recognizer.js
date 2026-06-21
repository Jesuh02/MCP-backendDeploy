/**
 * smart-recognizer.js — Orquestador inteligente de reconocimiento de señas.
 *
 * Recibe un flujo de frames de cámara (uno por request HTTP) y decide
 * autónomamente qué pipeline ejecutar según el comportamiento del usuario:
 *
 *   • Mano QUIETA durante ~1 segundo  → clasificador de LETRA/NÚMERO
 *     (ONNX local rápido; fallback al VLM para números o letras de baja
 *     confianza).
 *   • Manos en MOVIMIENTO sostenido seguido de pausa → reconocimiento de
 *     PALABRA/FRASE con el VLM sobre todo el clip acumulado.
 *
 * Estado por sesión (state machine):
 *
 *      ┌──────┐  motion>HIGH   ┌────────┐  motion<LOW    ┌──────────┐
 *      │ idle │ ─────────────▶ │ moving │ ─────────────▶ │ settling │
 *      └──┬───┘                └────┬───┘                └────┬─────┘
 *         │ motion<LOW              ▲                        │ +SETTLE_AFTER_MOTION_MS
 *         ▼                         │ motion>HIGH            ▼
 *      ┌───────┐ +STILL_DURATION  ┌─┴─────┐  ────────────▶  (VLM phrase)
 *      │ still │ ─────────────▶  │       │                  │
 *      └───────┘  (ONNX letter)  └───────┘                  ▼
 *                                                       ┌───────┐
 *                                                       │ still │
 *                                                       └───────┘
 *
 * Anti-falsos-positivos:
 *   - Letra repetida (misma mano sostenida) no se re-emite hasta que el
 *     usuario mueva la mano y vuelva a estabilizarse.
 *   - Phrase trigger requiere movimiento sostenido (≥ MIN_MOTION_DURATION_MS)
 *     Y pico de movimiento alto (≥ MOTION_PEAK_FOR_PHRASE). De lo contrario
 *     se asume reposicionamiento entre letras y se cae directo al letter
 *     trigger.
 *   - Mientras una invocación VLM/ONNX está en vuelo (`inflight`) los frames
 *     siguientes se procesan (motion tracking se mantiene) pero NO disparan
 *     una nueva inferencia hasta que la anterior termine.
 */

import { pushLetter, pushWord, getSessionDraft } from './phrase-composer.js';
import { computeThumbnail, motionScore } from './motion-detector.js';
import { classifyLetter } from './letter-classifier.js';
import { recognizeSignClip } from './sign-language-vlm.js';

// ---- Umbrales (todos ajustables por request via opts) -----------------------

/** Movimiento por píxel a partir del cual el frame es "claramente en movimiento". */
const MOTION_HIGH = 0.030;
/** Movimiento por píxel por debajo del cual el frame es "claramente quieto". */
const MOTION_LOW = 0.010;
/** Tiempo en estado `still` antes de disparar reconocimiento de letra (~1 s). */
const STILL_DURATION_MS = 1000;
/** Pausa requerida tras dejar de moverse para considerar el gesto terminado. */
const SETTLE_AFTER_MOTION_MS = 350;
/** Duración mínima del movimiento para considerarlo una palabra/frase. */
const MIN_MOTION_DURATION_MS = 500;
const MAX_MOTION_DURATION_MS = 4500;
/** Pico mínimo de motion durante el movimiento para considerarlo un gesto real
 *  (no un simple reposicionamiento de la mano entre letras). */
const MOTION_PEAK_FOR_PHRASE = 0.030;
/** Tiempo mínimo entre dos emisiones consecutivas de letra. */
const MIN_GAP_BETWEEN_LETTERS_MS = 1000;
/** Tiempo mínimo entre dos emisiones consecutivas de frase. */
const MIN_GAP_BETWEEN_PHRASES_MS = 1500;
const MIN_REPEAT_SAME_PHRASE_MS = 4000;
/** Tamaño máximo del buffer de frames por sesión. */
const FRAME_BUFFER_MAX = 60;
/** Edad máxima de un frame en el buffer (ms). */
const FRAME_BUFFER_MAX_AGE_MS = 6000;
/** Confianza mínima del clasificador ONNX para aceptar una letra. */
const MIN_LETTER_CONFIDENCE = 0.55;
/** Si ONNX devuelve < este valor consideramos pedir al VLM (números / letras raras). */
const ONNX_VLM_FALLBACK_THRESHOLD = 0.45;
const STATIC_VLM_HIGH_CONFIDENCE = 0.78;
const STATIC_VLM_NUMBER_PROBE_MIN_GAP_MS = 2500;
const STATIC_VLM_MODE = String(process.env.SIGN_LANGUAGE_STATIC_VLM_MODE || 'numbers').toLowerCase();
/** Confianza mínima de la salida del VLM (clip o single-frame) para aceptarla. */
const VLM_MIN_CONFIDENCE = 0.6;
/** TTL en memoria de cada sesión sin actividad. */
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_RECOGNITION_QUEUE = 4;
const MAX_PENDING_OUTPUTS = 8;

/**
 * @typedef {Object} RecognizerState
 * @property {string} id
 * @property {Uint8Array|null} lastThumbnail
 * @property {number} lastMotion
 * @property {'idle'|'moving'|'settling'|'still'} state
 * @property {number|null} stableSince          - inicio de la zona quieta actual
 * @property {number|null} motionStartAt        - inicio del periodo de movimiento actual
 * @property {number} motionPeak                - pico de movimiento durante el periodo actual
 * @property {Array<{at: number, buffer: Buffer}>} frames
 * @property {boolean} inflight
 * @property {number} lastFrameAt
 * @property {number} lastFrameSeq
 * @property {Array<Function>} recognitionQueue
 * @property {boolean} recognitionRunning
 * @property {Array<{event: Object|null, pushed: boolean, warning: Object|null}>} pendingOutputs
 * @property {boolean} disposed
 * @property {number} lastLetterEmitAt
 * @property {string|null} lastLetterLabel
 * @property {number} lastPhraseEmitAt
 * @property {number} lastPhraseAcceptedAt
 * @property {string|null} lastPhraseKey
 * @property {number} lastStaticVlmAt
 * @property {number} lastTouchedAt
 */

/** @type {Map<string, RecognizerState>} */
const states = new Map();
/** @type {Map<string, Promise<unknown>>} */
const frameChains = new Map();
let purgeTimer = null;

function startPurgeTimer() {
    if (purgeTimer) return;
    purgeTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of states) {
            if (now - s.lastTouchedAt > SESSION_TTL_MS) {
                s.disposed = true;
                states.delete(id);
                frameChains.delete(id);
            }
        }
        if (states.size === 0) {
            clearInterval(purgeTimer);
            purgeTimer = null;
        }
    }, 60_000).unref?.();
}

function getOrCreateState(id) {
    let s = states.get(id);
    if (!s) {
        s = {
            id,
            lastThumbnail: null,
            lastMotion: 0,
            state: 'idle',
            stableSince: null,
            motionStartAt: null,
            motionPeak: 0,
            frames: [],
            inflight: false,
            lastFrameAt: 0,
            lastFrameSeq: 0,
            recognitionQueue: [],
            recognitionRunning: false,
            pendingOutputs: [],
            disposed: false,
            lastLetterEmitAt: 0,
            lastLetterLabel: null,
            lastPhraseEmitAt: 0,
            lastPhraseAcceptedAt: 0,
            lastPhraseKey: null,
            lastStaticVlmAt: 0,
            lastTouchedAt: Date.now(),
        };
        states.set(id, s);
        startPurgeTimer();
    }
    return s;
}

/**
 * Borra el estado de motion-tracking de una sesión (no toca el draft del
 * phrase-composer; usa deleteSession() en phrase-composer para eso).
 */
export function resetRecognizerState(id) {
    const safeId = String(id || '');
    const state = states.get(safeId);
    if (state) state.disposed = true;
    states.delete(safeId);
    frameChains.delete(safeId);
}

function pruneFrameBuffer(state, now) {
    while (
        state.frames.length > FRAME_BUFFER_MAX ||
        (state.frames.length && now - state.frames[0].at > FRAME_BUFFER_MAX_AGE_MS)
    ) {
        state.frames.shift();
    }
}

function isSingleLetter(text) {
    return Array.from(String(text || '').trim()).length === 1;
}

function tokenKey(kind, text) {
    return `${kind}:${String(text || '').trim().toLocaleUpperCase('es')}`;
}

function isNumberConfusableLetter(label) {
    return ['B', 'C', 'F', 'I', 'L', 'O', 'V', 'W', 'Y'].includes(
        String(label || '').trim().toLocaleUpperCase('es'),
    );
}

function pushRecognizedToken(sessionId, result) {
    const text = String(result?.text ?? '').trim();
    const confidence = Number(result?.confidence) || 0;
    if (!text) return false;
    if (result.kind === 'letter' && isSingleLetter(text)) {
        pushLetter(sessionId, { label: text, confidence });
        return true;
    }
    pushWord(sessionId, { text, confidence });
    return true;
}

function recognitionBacklogSize(state) {
    return state.recognitionQueue.length + (state.recognitionRunning ? 1 : 0);
}

function canQueueRecognition(state) {
    return !state.disposed && recognitionBacklogSize(state) < MAX_RECOGNITION_QUEUE;
}

function pushPendingOutput(state, output) {
    if (state.disposed || !output) return;
    state.pendingOutputs.push({
        event: output.event || null,
        pushed: Boolean(output.pushed),
        warning: output.warning || null,
    });
    while (state.pendingOutputs.length > MAX_PENDING_OUTPUTS) state.pendingOutputs.shift();
}

function popPendingOutput(state) {
    return state.pendingOutputs.shift() || null;
}

function enqueueRecognitionJob(state, job) {
    if (!canQueueRecognition(state)) return false;
    state.recognitionQueue.push(job);
    void drainRecognitionQueue(state);
    return true;
}

async function drainRecognitionQueue(state) {
    if (state.recognitionRunning || state.disposed) return;
    state.recognitionRunning = true;
    state.inflight = true;
    try {
        while (!state.disposed && state.recognitionQueue.length) {
            const job = state.recognitionQueue.shift();
            try {
                await job();
            } catch (err) {
                console.warn('[SmartRecognizer] recognition job falló:', err?.message || err);
                pushPendingOutput(state, {
                    warning: {
                        code: err?.code || 'RECOGNITION_JOB_FAILED',
                        message: err?.message || 'Falló una inferencia de señas.',
                    },
                });
            }
        }
    } finally {
        state.recognitionRunning = false;
        state.inflight = state.recognitionQueue.length > 0;
        if (state.recognitionQueue.length && !state.disposed) void drainRecognitionQueue(state);
    }
}

function eventFromVlm(source, result) {
    return {
        source,
        kind: result.kind,
        text: result.text,
        confidence: result.confidence,
        alternatives: result.alternatives || [],
        handedness: result.handedness,
        motion: result.motion,
        nonManual: result.nonManual,
        reasoning: result.reasoning,
        model: result.model,
    };
}

function eventFromStaticCandidate(source, candidate) {
    return {
        source,
        kind: candidate.kind,
        text: candidate.text,
        confidence: candidate.confidence,
        alternatives: candidate.alternatives || [],
        handedness: candidate.handedness || 'none',
        motion: candidate.motion || { trajectory: '', direction: 'none', repeated: false, contact: 'none' },
        nonManual: candidate.nonManual || { facial: null, intent: 'unknown' },
        reasoning: candidate.reasoning || '',
        model: candidate.model,
    };
}

function shouldUseStaticVlm(candidate, state, now, language) {
    if (STATIC_VLM_MODE === 'off') return false;
    if (STATIC_VLM_MODE === 'always') return true;

    // Para LSC (Lengua de Señas Colombiana), SIEMPRE usar VLM porque el modelo
    // ONNX está entrenado en ASL, no en LSC. El VLM con los prompts LSC dará
    // mejores resultados para el alfabeto dactilológico colombiano.
    const lang = String(language || '').toLowerCase();
    if (['lsc', 'es', 'es-co', 'spanish', 'colombian', 'colombia'].includes(lang)) {
        // Pequeña espera entre llamadas VLM para no saturar
        if (now - state.lastStaticVlmAt < 800) return false;
        return true;
    }

    if (!candidate) return true;

    const confidence = Number(candidate.confidence) || 0;
    if (confidence < ONNX_VLM_FALLBACK_THRESHOLD) return true;
    if (STATIC_VLM_MODE === 'numbers') {
        if (now - state.lastStaticVlmAt < STATIC_VLM_NUMBER_PROBE_MIN_GAP_MS) return false;
        if (confidence >= STATIC_VLM_HIGH_CONFIDENCE && !isNumberConfusableLetter(candidate.text)) return false;
        return true;
    }
    return confidence < ONNX_VLM_FALLBACK_THRESHOLD;
}

function buildCaptureMeta(state, now, motion) {
    const stillMs = state.stableSince == null ? 0 : Math.max(0, now - state.stableSince);
    const motionMs = state.motionStartAt == null ? 0 : Math.max(0, now - state.motionStartAt);
    const physicalMode =
        state.state === 'moving' && motionMs >= MAX_MOTION_DURATION_MS ? 'sentence' :
        state.state === 'moving' ? 'moving' :
        state.state === 'settling' ? 'settling' :
        state.state === 'still' ? 'still' :
        'idle';

    return {
        mode: state.inflight && physicalMode === 'idle' ? 'processing' : physicalMode,
        stillMs,
        motionMs,
        motionPeak: state.motionPeak,
        motion,
        inflight: state.inflight,
        queue: recognitionBacklogSize(state),
    };
}

/**
 * Punto de entrada principal: alimenta un frame al recognizer y devuelve
 * el evento producido (si lo hubo), el motion actual, el estado, y el
 * draft acumulado del phrase-composer.
 *
 * @param {string} sessionId
 * @param {Buffer} frameBuffer
 * @param {Object} [opts]
 * @param {string} [opts.context]              - contexto previo para el VLM
 * @param {string} [opts.model]                - modelo VLM override
 * @param {string} [opts.language]             - 'asl' (default) o 'lsc'
 * @param {number} [opts.minLetterConfidence]  - override de MIN_LETTER_CONFIDENCE
 * @param {number} [opts.minPhraseConfidence]  - override de VLM_MIN_CONFIDENCE
 * @param {number} [opts.stillDurationMs]      - override de STILL_DURATION_MS
 * @param {number} [opts.capturedAtMs]         - timestamp epoch ms del frame en la camara
 * @param {number} [opts.frameSeq]             - secuencia monotÃ³nica emitida por el frontend
 * @param {boolean} [opts.allowVlmLetterFallback=true] - si ONNX duda, usar VLM
 * @param {boolean} [opts.debug=false]
 */
export async function ingestFrame(sessionId, frameBuffer, opts = {}) {
    const safeId = String(sessionId || '').slice(0, 64);
    if (!safeId) throw new Error('sessionId requerido');
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length < 100) {
        throw new Error('frameBuffer inválido');
    }

    const previous = frameChains.get(safeId) || Promise.resolve();
    const queued = previous
        .catch(() => {})
        .then(() => ingestFrameNow(safeId, frameBuffer, opts));
    frameChains.set(safeId, queued);
    queued
        .finally(() => {
            if (frameChains.get(safeId) === queued) frameChains.delete(safeId);
        })
        .catch(() => {});
    return queued;
}

async function ingestFrameNow(safeId, frameBuffer, opts = {}) {
    const state = getOrCreateState(safeId);
    const receivedAt = Date.now();
    const capturedAt = Number(opts.capturedAtMs);
    const frameSeq = Number(opts.frameSeq);
    const now = Number.isFinite(capturedAt) && capturedAt > 0
        ? Math.max(capturedAt, state.lastFrameAt + 1)
        : receivedAt;
    state.lastTouchedAt = receivedAt;

    const staleBySeq = Number.isFinite(frameSeq) && frameSeq > 0 && state.lastFrameSeq && frameSeq <= state.lastFrameSeq;
    const staleByTime = !Number.isFinite(frameSeq) && state.lastFrameAt && capturedAt > 0 && capturedAt <= state.lastFrameAt;
    if (staleBySeq || staleByTime) {
        const { draft, eventCount } = getSessionDraft(safeId);
        return {
            event: null,
            pushed: false,
            motion: state.lastMotion,
            state: state.state,
            draft,
            eventCount,
            capture: buildCaptureMeta(state, state.lastFrameAt, state.lastMotion),
            warning: {
                code: 'STALE_FRAME',
                message: 'Frame recibido fuera de orden; se ignoro para conservar el tracking temporal.',
            },
        };
    }
    state.lastFrameAt = now;
    if (Number.isFinite(frameSeq) && frameSeq > 0) state.lastFrameSeq = frameSeq;

    // 1) Motion tracking (siempre, incluso si hay inferencia en vuelo).
    let thumb = null;
    let motion = 0;
    try {
        thumb = await computeThumbnail(frameBuffer);
        motion = state.lastThumbnail ? motionScore(state.lastThumbnail, thumb) : 0;
    } catch (err) {
        console.warn('[SmartRecognizer] thumbnail falló:', err?.message || err);
    }
    if (thumb) state.lastThumbnail = thumb;
    state.lastMotion = motion;

    // Buffer de frames para clip-recognition.
    state.frames.push({ at: now, buffer: frameBuffer });
    pruneFrameBuffer(state, now);

    // 2) State machine.
    const prevState = state.state;
    if (motion >= MOTION_HIGH) {
        if (state.state !== 'moving') {
            state.state = 'moving';
            state.motionStartAt = state.motionStartAt ?? now;
            state.motionPeak = motion;
            state.lastLetterLabel = null;
        } else {
            if (motion > state.motionPeak) state.motionPeak = motion;
        }
        state.stableSince = null;
    } else if (motion <= MOTION_LOW) {
        if (state.state === 'moving') {
            state.state = 'settling';
            state.stableSince = now;
        } else if (state.state === 'settling') {
            // mantiene stableSince original (cuando bajó de moving)
            if (state.stableSince == null) state.stableSince = now;
        } else {
            // idle o still
            if (state.state === 'idle') state.state = 'still';
            if (state.stableSince == null) state.stableSince = now;
        }
    } else {
        // Movimiento medio: si ya estábamos en moving, sigue acumulando pico.
        if (state.state === 'moving' && motion > state.motionPeak) state.motionPeak = motion;
        // En cualquier otro estado, no cambiamos (zona muerta).
    }

    // Configuración por request.
    const minLetterConf = Number.isFinite(opts.minLetterConfidence) ? opts.minLetterConfidence : MIN_LETTER_CONFIDENCE;
    const minPhraseConf = Number.isFinite(opts.minPhraseConfidence) ? opts.minPhraseConfidence : VLM_MIN_CONFIDENCE;
    const stillDurationMs = Number.isFinite(opts.stillDurationMs) ? opts.stillDurationMs : STILL_DURATION_MS;
    const allowVlmLetterFallback = opts.allowVlmLetterFallback !== false;

    const pendingOutput = popPendingOutput(state);
    let event = pendingOutput?.event || null;
    let pushed = Boolean(pendingOutput?.pushed);
    let warning = pendingOutput?.warning || null;

    const settlingReady =
        state.state === 'settling' &&
        state.stableSince != null &&
        now - state.stableSince >= SETTLE_AFTER_MOTION_MS;
    const movingWindowReady =
        state.state === 'moving' &&
        state.motionStartAt != null &&
        now - state.motionStartAt >= MAX_MOTION_DURATION_MS;

    // 3) Trigger de PALABRA/FRASE — settling estable lo suficiente, con
    //    movimiento previo sustancial (duración + pico).
    if (
        (settlingReady || movingWindowReady) &&
        state.motionStartAt != null &&
        now - state.lastPhraseEmitAt >= MIN_GAP_BETWEEN_PHRASES_MS &&
        canQueueRecognition(state)
    ) {
        const clipEndAt = settlingReady ? (state.stableSince || now) : now;
        const motionDuration = clipEndAt - state.motionStartAt;
        const looksLikePhrase =
            motionDuration >= MIN_MOTION_DURATION_MS &&
            state.motionPeak >= MOTION_PEAK_FOR_PHRASE;

        if (looksLikePhrase) {
            const clipStartAt = state.motionStartAt;
            const clipFrames = state.frames
                .filter((f) => f.at >= clipStartAt - 200 && f.at <= clipEndAt + 200)
                .map((f) => f.buffer);

            if (clipFrames.length >= 2) {
                const triggerAt = now;
                const source = movingWindowReady ? 'sentence-window' : 'phrase';
                const mode = movingWindowReady ? 'sentence' : 'dynamic';
                state.lastPhraseEmitAt = triggerAt;
                state.frames = state.frames.filter((f) => f.at >= clipEndAt - 200);
                if (movingWindowReady) {
                    state.state = 'moving';
                    state.motionStartAt = now;
                    state.motionPeak = motion;
                    state.stableSince = null;
                } else {
                    state.state = 'still';
                    state.stableSince = now;
                    state.motionStartAt = null;
                    state.motionPeak = 0;
                }
                enqueueRecognitionJob(state, async () => {
                    try {
                        if (state.disposed) return;
                        const previousText = getSessionDraft(safeId)?.draft || '';
                        const result = await recognizeSignClip(clipFrames, {
                            context: typeof opts.context === 'string' ? opts.context : undefined,
                            previousText: previousText || undefined,
                            model: typeof opts.model === 'string' ? opts.model : undefined,
                            language: typeof opts.language === 'string' ? opts.language : undefined,
                            mode,
                        });
                        if (
                            result &&
                            result.text &&
                            result.kind !== 'unknown' &&
                            result.confidence >= minPhraseConf
                        ) {
                            const phraseKey = tokenKey(result.kind, result.text);
                            const repeatedTooSoon =
                                phraseKey === state.lastPhraseKey &&
                                triggerAt - state.lastPhraseAcceptedAt < MIN_REPEAT_SAME_PHRASE_MS;
                            if (!repeatedTooSoon && !state.disposed) {
                                const didPush = pushRecognizedToken(safeId, result);
                                state.lastPhraseAcceptedAt = triggerAt;
                                state.lastPhraseKey = phraseKey;
                                state.lastLetterLabel = null;
                                pushPendingOutput(state, {
                                    pushed: didPush,
                                    event: eventFromVlm(source, result),
                                });
                            }
                        }
                    } catch (err) {
                        console.warn('[SmartRecognizer] phrase recognition falló:', err?.message || err);
                        pushPendingOutput(state, {
                            warning: {
                                code: err?.code || 'VLM_FAILED',
                                message: err?.message || 'No se pudo reconocer la sena dinamica.',
                            },
                        });
                    }
                });
            } else {
                state.state = 'still';
                state.stableSince = now;
                state.motionStartAt = null;
                state.motionPeak = 0;
                state.frames = state.frames.slice(-2);
            }
        }

        // Cierra el periodo de movimiento (haya o no disparado).
        if (!looksLikePhrase) {
            state.state = 'still';
            state.stableSince = now;
            state.motionStartAt = null;
            state.motionPeak = 0;
        }
        // Conserva solo los últimos frames (los próximos letters / phrases
        // empezarán a llenar el buffer desde aquí).
        if (!looksLikePhrase) state.frames = state.frames.slice(-2);
    }

    // 4) Trigger de LETRA/NÚMERO — quieto el tiempo suficiente, sin emit reciente.
    if (
        !event &&
        state.state === 'still' &&
        state.stableSince != null &&
        now - state.stableSince >= stillDurationMs &&
        now - state.lastLetterEmitAt >= MIN_GAP_BETWEEN_LETTERS_MS &&
        canQueueRecognition(state)
    ) {
        const triggerAt = now;
        const staticFrame = frameBuffer;
        state.lastLetterEmitAt = triggerAt;
        state.stableSince = triggerAt;
        enqueueRecognitionJob(state, async () => {
            try {
                if (state.disposed) return;
                let candidate = null;

                try {
                    const onnx = await classifyLetter(staticFrame);
                    if (onnx && onnx.detection) {
                        candidate = {
                            source: 'onnx-letter',
                            kind: 'letter',
                            text: onnx.detection.label,
                            confidence: onnx.detection.confidence,
                            alternatives: onnx.alternatives || [],
                        };
                    }
                } catch (err) {
                    console.warn('[SmartRecognizer] ONNX letter falló:', err?.message || err);
                }

                const userLanguage = typeof opts.language === 'string' ? opts.language : undefined;
                if (allowVlmLetterFallback && shouldUseStaticVlm(candidate, state, triggerAt, userLanguage)) {
                    try {
                        state.lastStaticVlmAt = triggerAt;
                        const previousText = getSessionDraft(safeId)?.draft || '';
                        const vlm = await recognizeSignClip([staticFrame], {
                            context: typeof opts.context === 'string' ? opts.context : undefined,
                            previousText: previousText || undefined,
                            model: typeof opts.model === 'string' ? opts.model : undefined,
                            language: userLanguage,
                            mode: 'static',
                        });
                        if (
                            vlm &&
                            vlm.text &&
                            (vlm.kind === 'letter' || vlm.kind === 'number') &&
                            vlm.confidence >= minPhraseConf
                        ) {
                            // Para LSC, siempre preferir VLM sobre ONNX porque el modelo
                            // ONNX está entrenado en ASL, no en el alfabeto colombiano
                            const isLsc = ['lsc', 'es', 'es-co', 'spanish', 'colombian', 'colombia'].includes(
                                String(userLanguage || '').toLowerCase()
                            );
                            const vlmWins =
                                isLsc ||
                                vlm.kind === 'number' ||
                                STATIC_VLM_MODE === 'always' ||
                                !candidate ||
                                candidate.confidence < minLetterConf;
                            if (vlmWins) {
                                candidate = {
                                    ...vlm,
                                    source: vlm.kind === 'number' ? 'vlm-number' : 'vlm-letter',
                                };
                            }
                        }
                    } catch (err) {
                        console.warn('[SmartRecognizer] VLM letter fallback falló:', err?.message || err);
                        pushPendingOutput(state, {
                            warning: {
                                code: err?.code || 'VLM_FAILED',
                                message: err?.message || 'No se pudo verificar letra o numero con VLM.',
                            },
                        });
                    }
                }

                if (
                    candidate &&
                    candidate.text &&
                    candidate.confidence >= (candidate.kind === 'number' ? minPhraseConf : minLetterConf)
                ) {
                    const staticKey = tokenKey(candidate.kind, candidate.text);
                    if (staticKey !== state.lastLetterLabel && !state.disposed) {
                        const didPush = pushRecognizedToken(safeId, candidate);
                        state.lastLetterLabel = staticKey;
                        state.lastLetterEmitAt = triggerAt;
                        pushPendingOutput(state, {
                            pushed: didPush,
                            event: eventFromStaticCandidate(candidate.source || 'static', candidate),
                        });
                    } else {
                        state.lastLetterEmitAt = triggerAt;
                    }
                }
            } catch (err) {
                console.warn('[SmartRecognizer] letter trigger falló:', err?.message || err);
            }
        });
    }

    const { draft, eventCount } = getSessionDraft(safeId);

    return {
        event,
        pushed,
        motion,
        state: state.state,
        draft,
        eventCount,
        capture: buildCaptureMeta(state, now, motion),
        warning,
        ...(opts.debug ? {
            debug: {
                prevState,
                stableSince: state.stableSince,
                motionStartAt: state.motionStartAt,
                motionPeak: state.motionPeak,
                framesInBuffer: state.frames.length,
                lastLetterLabel: state.lastLetterLabel,
                lastPhraseKey: state.lastPhraseKey,
                lastStaticVlmAt: state.lastStaticVlmAt,
                lastFrameAt: state.lastFrameAt,
                lastFrameSeq: state.lastFrameSeq,
                recognitionQueue: state.recognitionQueue.length,
                recognitionRunning: state.recognitionRunning,
                pendingOutputs: state.pendingOutputs.length,
                inflight: state.inflight,
            },
        } : {}),
    };
}

export default { ingestFrame, resetRecognizerState };
