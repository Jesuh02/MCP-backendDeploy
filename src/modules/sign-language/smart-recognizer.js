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
const MOTION_LOW = 0.015;
/** Tiempo en estado `still` antes de disparar reconocimiento de letra (~1 s). */
const STILL_DURATION_MS = 900;
/** Pausa requerida tras dejar de moverse para considerar el gesto terminado. */
const SETTLE_AFTER_MOTION_MS = 350;
/** Duración mínima del movimiento para considerarlo una palabra/frase. */
const MIN_MOTION_DURATION_MS = 500;
/** Pico mínimo de motion durante el movimiento para considerarlo un gesto real
 *  (no un simple reposicionamiento de la mano entre letras). */
const MOTION_PEAK_FOR_PHRASE = 0.060;
/** Tiempo mínimo entre dos emisiones consecutivas de letra. */
const MIN_GAP_BETWEEN_LETTERS_MS = 1000;
/** Tiempo mínimo entre dos emisiones consecutivas de frase. */
const MIN_GAP_BETWEEN_PHRASES_MS = 1500;
/** Tamaño máximo del buffer de frames por sesión. */
const FRAME_BUFFER_MAX = 24;
/** Edad máxima de un frame en el buffer (ms). */
const FRAME_BUFFER_MAX_AGE_MS = 3500;
/** Confianza mínima del clasificador ONNX para aceptar una letra. */
const MIN_LETTER_CONFIDENCE = 0.55;
/** Si ONNX devuelve < este valor consideramos pedir al VLM (números / letras raras). */
const ONNX_VLM_FALLBACK_THRESHOLD = 0.45;
/** Confianza mínima de la salida del VLM (clip o single-frame) para aceptarla. */
const VLM_MIN_CONFIDENCE = 0.6;
/** TTL en memoria de cada sesión sin actividad. */
const SESSION_TTL_MS = 5 * 60 * 1000;

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
 * @property {number} lastLetterEmitAt
 * @property {string|null} lastLetterLabel
 * @property {number} lastPhraseEmitAt
 * @property {number} lastTouchedAt
 */

/** @type {Map<string, RecognizerState>} */
const states = new Map();
let purgeTimer = null;

function startPurgeTimer() {
    if (purgeTimer) return;
    purgeTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of states) {
            if (now - s.lastTouchedAt > SESSION_TTL_MS) states.delete(id);
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
            lastLetterEmitAt: 0,
            lastLetterLabel: null,
            lastPhraseEmitAt: 0,
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
    states.delete(String(id || ''));
}

function pruneFrameBuffer(state, now) {
    while (
        state.frames.length > FRAME_BUFFER_MAX ||
        (state.frames.length && now - state.frames[0].at > FRAME_BUFFER_MAX_AGE_MS)
    ) {
        state.frames.shift();
    }
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
 * @param {number} [opts.minLetterConfidence]  - override de MIN_LETTER_CONFIDENCE
 * @param {number} [opts.minPhraseConfidence]  - override de VLM_MIN_CONFIDENCE
 * @param {number} [opts.stillDurationMs]      - override de STILL_DURATION_MS
 * @param {boolean} [opts.allowVlmLetterFallback=true] - si ONNX duda, usar VLM
 * @param {boolean} [opts.debug=false]
 */
export async function ingestFrame(sessionId, frameBuffer, opts = {}) {
    const safeId = String(sessionId || '').slice(0, 64);
    if (!safeId) throw new Error('sessionId requerido');
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length < 100) {
        throw new Error('frameBuffer inválido');
    }

    const state = getOrCreateState(safeId);
    const now = Date.now();
    state.lastTouchedAt = now;

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

    let event = null;
    let pushed = false;

    // 3) Trigger de PALABRA/FRASE — settling estable lo suficiente, con
    //    movimiento previo sustancial (duración + pico).
    if (
        state.state === 'settling' &&
        state.stableSince != null &&
        now - state.stableSince >= SETTLE_AFTER_MOTION_MS &&
        state.motionStartAt != null &&
        now - state.lastPhraseEmitAt >= MIN_GAP_BETWEEN_PHRASES_MS &&
        !state.inflight
    ) {
        const motionDuration = state.stableSince - state.motionStartAt;
        const looksLikePhrase =
            motionDuration >= MIN_MOTION_DURATION_MS &&
            state.motionPeak >= MOTION_PEAK_FOR_PHRASE;

        if (looksLikePhrase) {
            const clipFrames = state.frames
                .filter((f) => f.at >= state.motionStartAt - 200 && f.at <= state.stableSince + 200)
                .map((f) => f.buffer);

            if (clipFrames.length >= 2) {
                state.inflight = true;
                try {
                    const result = await recognizeSignClip(clipFrames, {
                        context: typeof opts.context === 'string' ? opts.context : undefined,
                        model: typeof opts.model === 'string' ? opts.model : undefined,
                    });
                    if (
                        result &&
                        result.text &&
                        result.kind !== 'unknown' &&
                        result.confidence >= minPhraseConf
                    ) {
                        if (result.kind === 'letter' || result.kind === 'number') {
                            pushLetter(safeId, { label: result.text, confidence: result.confidence });
                        } else {
                            pushWord(safeId, { text: result.text, confidence: result.confidence });
                        }
                        pushed = true;
                        event = {
                            source: 'phrase',
                            kind: result.kind,
                            text: result.text,
                            confidence: result.confidence,
                            alternatives: result.alternatives || [],
                            reasoning: result.reasoning,
                        };
                        state.lastPhraseEmitAt = now;
                        state.lastLetterLabel = null; // permite re-emitir misma letra después de una frase
                    }
                } catch (err) {
                    console.warn('[SmartRecognizer] phrase recognition falló:', err?.message || err);
                } finally {
                    state.inflight = false;
                }
            }
        }

        // Cierra el periodo de movimiento (haya o no disparado).
        state.state = 'still';
        state.stableSince = now;
        state.motionStartAt = null;
        state.motionPeak = 0;
        // Conserva solo los últimos frames (los próximos letters / phrases
        // empezarán a llenar el buffer desde aquí).
        state.frames = state.frames.slice(-2);
    }

    // 4) Trigger de LETRA/NÚMERO — quieto el tiempo suficiente, sin emit reciente.
    if (
        !event &&
        state.state === 'still' &&
        state.stableSince != null &&
        now - state.stableSince >= stillDurationMs &&
        now - state.lastLetterEmitAt >= MIN_GAP_BETWEEN_LETTERS_MS &&
        !state.inflight
    ) {
        state.inflight = true;
        try {
            // 4a) Camino rápido: ONNX local (solo A-Z).
            let label = null;
            let confidence = 0;
            let alternatives = [];
            let kind = 'letter';

            try {
                const onnx = await classifyLetter(frameBuffer);
                if (onnx && onnx.detection) {
                    label = onnx.detection.label;
                    confidence = onnx.detection.confidence;
                    alternatives = onnx.alternatives || [];
                }
            } catch (err) {
                console.warn('[SmartRecognizer] ONNX letter falló:', err?.message || err);
            }

            // 4b) Fallback VLM (números o letras de baja confianza).
            if (allowVlmLetterFallback && confidence < ONNX_VLM_FALLBACK_THRESHOLD) {
                try {
                    const vlm = await recognizeSignClip([frameBuffer], {
                        context: typeof opts.context === 'string' ? opts.context : undefined,
                        model: typeof opts.model === 'string' ? opts.model : undefined,
                    });
                    if (
                        vlm &&
                        vlm.text &&
                        (vlm.kind === 'letter' || vlm.kind === 'number') &&
                        vlm.confidence >= minPhraseConf
                    ) {
                        label = vlm.text;
                        confidence = vlm.confidence;
                        alternatives = vlm.alternatives || [];
                        kind = vlm.kind;
                    }
                } catch (err) {
                    console.warn('[SmartRecognizer] VLM letter fallback falló:', err?.message || err);
                }
            }

            if (label && confidence >= (kind === 'number' ? minPhraseConf : minLetterConf)) {
                if (label !== state.lastLetterLabel) {
                    pushLetter(safeId, { label, confidence });
                    pushed = true;
                    state.lastLetterLabel = label;
                    state.lastLetterEmitAt = now;
                    event = {
                        source: kind === 'number' ? 'vlm-number' : (kind === 'letter' ? (alternatives.length ? 'onnx-letter' : 'vlm-letter') : 'letter'),
                        kind,
                        text: label,
                        confidence,
                        alternatives,
                    };
                } else {
                    // Misma letra sostenida: refrescamos el debounce sin re-emitir.
                    state.lastLetterEmitAt = now;
                }
            }
        } catch (err) {
            console.warn('[SmartRecognizer] letter trigger falló:', err?.message || err);
        } finally {
            state.inflight = false;
        }

        // Reinicia stableSince para que pasen otros STILL_DURATION_MS antes de reintentar.
        state.stableSince = now;
    }

    const { draft, eventCount } = getSessionDraft(safeId);

    return {
        event,
        pushed,
        motion,
        state: state.state,
        draft,
        eventCount,
        ...(opts.debug ? {
            debug: {
                prevState,
                stableSince: state.stableSince,
                motionStartAt: state.motionStartAt,
                motionPeak: state.motionPeak,
                framesInBuffer: state.frames.length,
                lastLetterLabel: state.lastLetterLabel,
                inflight: state.inflight,
            },
        } : {}),
    };
}

export default { ingestFrame, resetRecognizerState };
