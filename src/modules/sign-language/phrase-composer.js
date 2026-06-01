/**
 * phrase-composer.js — Compositor de frases para lengua de señas.
 *
 * El clasificador de imagen estática solo produce letras A-Z. Este módulo:
 *   1. Mantiene un buffer por sesión con las letras confirmadas y sus
 *      timestamps.
 *   2. Detecta límites de palabra: si pasan más de WORD_GAP_MS sin
 *      detección, se inserta un espacio implícito.
 *   3. Aplica heurísticas locales rápidas (colapso de letras repetidas
 *      pegadas, normalización a minúsculas, recorte de espacios).
 *   4. Llama al LLM (Qwen vía OpenRouter / DeepSeek fallback) con un
 *      prompt cerrado para convertir la secuencia ruidosa en una frase
 *      coherente en español.
 *
 * El LLM se invoca de forma síncrona pero con timeout corto. Si el LLM
 * falla o no está disponible, devolvemos la versión heurística (no
 * rompemos el flujo del usuario).
 *
 * Sesiones en memoria con TTL (no se persisten en DB porque son
 * efímeras y de bajo valor histórico).
 */

import { LLMService } from '../ai/infrastructure/llm.service.js';

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 min sin actividad → se purga
const WORD_GAP_MS = 1800;             // gap entre letras → espacio implícito
const MAX_SEQUENCE_LEN = 240;          // límite duro por sesión
const LLM_PRIMARY_TIMEOUT_MS = 8000;   // si el LLM tarda más, abortamos

/**
 * Eventos en la sesión.
 *   kind="letter" → label es una sola letra (alfabeto, pipeline ONNX).
 *   kind="word"   → label es una palabra/frase reconocida por el VLM
 *                   (puede contener espacios o signos de puntuación).
 *
 * @typedef {{ kind: 'letter'|'word', label: string, confidence: number, at: number }} ComposerEvent
 */

/**
 * @typedef {Object} ComposerSession
 * @property {string} id
 * @property {ComposerEvent[]} events
 * @property {number} createdAt
 * @property {number} lastTouchedAt
 */

/** @type {Map<string, ComposerSession>} */
const sessions = new Map();

let purgeTimer = null;

function startPurgeTimerIfNeeded() {
    if (purgeTimer) return;
    purgeTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of sessions) {
            if (now - s.lastTouchedAt > SESSION_TTL_MS) sessions.delete(id);
        }
        if (sessions.size === 0) {
            clearInterval(purgeTimer);
            purgeTimer = null;
        }
    }, 60 * 1000).unref?.();
}

export function getOrCreateSession(id) {
    const safeId = String(id || '').slice(0, 64);
    if (!safeId) throw new Error('session id requerido');
    let s = sessions.get(safeId);
    if (!s) {
        s = { id: safeId, events: [], createdAt: Date.now(), lastTouchedAt: Date.now() };
        sessions.set(safeId, s);
        startPurgeTimerIfNeeded();
    }
    return s;
}

export function deleteSession(id) {
    sessions.delete(String(id || ''));
}

/**
 * Registra una letra confirmada en la sesión. Devuelve el draft actual
 * (secuencia con espacios implícitos por gaps).
 *
 * @param {string} id
 * @param {{ label: string, confidence: number }} detection
 * @returns {{ draft: string, events: LetterEvent[] }}
 */
export function pushLetter(id, detection) {
    const s = getOrCreateSession(id);
    const now = Date.now();
    const label = String(detection?.label ?? '').trim().toUpperCase();
    if (!label) return { draft: buildDraft(s.events), events: s.events };

    if (s.events.length >= MAX_SEQUENCE_LEN) {
        // Buffer lleno: descartamos las más viejas (FIFO).
        s.events.splice(0, s.events.length - MAX_SEQUENCE_LEN + 1);
    }

    s.events.push({
        kind: 'letter',
        label,
        confidence: Number(detection?.confidence) || 0,
        at: now,
    });
    s.lastTouchedAt = now;
    return { draft: buildDraft(s.events), events: s.events };
}

/**
 * Registra una palabra/frase completa reconocida por el VLM. Se trata
 * como un "token" indivisible: siempre va con espacio antes y después
 * en el draft (no se colapsa con letras adyacentes).
 *
 * @param {string} id
 * @param {{ text: string, confidence?: number }} detection
 * @returns {{ draft: string, events: ComposerEvent[] }}
 */
export function pushWord(id, detection) {
    const s = getOrCreateSession(id);
    const now = Date.now();
    const label = String(detection?.text ?? '').trim();
    if (!label) return { draft: buildDraft(s.events), events: s.events };

    if (s.events.length >= MAX_SEQUENCE_LEN) {
        s.events.splice(0, s.events.length - MAX_SEQUENCE_LEN + 1);
    }

    s.events.push({
        kind: 'word',
        label,
        confidence: Number(detection?.confidence) || 0,
        at: now,
    });
    s.lastTouchedAt = now;
    return { draft: buildDraft(s.events), events: s.events };
}

/**
 * Construye un draft a partir de los eventos:
 *   - inserta un espacio si el gap entre eventos > WORD_GAP_MS
 *   - colapsa letras repetidas consecutivas (HHOLA -> HOLA) cuando el
 *     gap entre las dos detecciones es < 700 ms (sugiere mantenimiento
 *     de la misma seña, no doble pulsación intencional)
 */
function buildDraft(events) {
    if (!events.length) return '';
    let out = '';
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const prev = events[i - 1];
        const isWord = e.kind === 'word';
        const prevWasWord = prev && prev.kind === 'word';
        if (prev) {
            const gap = e.at - prev.at;
            if (isWord || prevWasWord) {
                // Palabras del VLM siempre separadas con un espacio.
                if (out && !out.endsWith(' ')) out += ' ';
            } else if (gap > WORD_GAP_MS) {
                out += ' ';
            } else if (e.label === prev.label && gap < 700) {
                // misma letra muy seguida → ignorar duplicado
                continue;
            }
        }
        out += e.label;
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Limpieza local sin LLM (fallback determinístico).
 *   - Colapsa letras idénticas adyacentes (HHOLLA -> HOLA).
 *   - Pasa a minúsculas, capitaliza la primera letra de cada oración.
 */
export function cleanLocal(raw) {
    if (!raw) return '';
    const collapsed = String(raw)
        .toUpperCase()
        .replace(/([A-ZÑ])\1{1,}/g, '$1')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return collapsed.replace(/(^|[.!?¡¿]\s+)([a-záéíóúñ])/g, (_m, p1, p2) => p1 + p2.toUpperCase());
}

/**
 * Llama al LLM para convertir la secuencia ruidosa en español coherente.
 * Devuelve `null` si el LLM no está disponible / falla / time-out.
 *
 * @param {string} rawSequence
 * @param {{ context?: string }} [opts]
 * @returns {Promise<string|null>}
 */
async function llmCompose(rawSequence, opts = {}) {
    try {
        const { HumanMessage, SystemMessage } = await import('@langchain/core/messages');
        const llm = LLMService.getInstance();

        const systemPrompt = [
            'Eres un asistente especializado en transcribir lengua de señas a español.',
            'Recibes una secuencia RUIDOSA de letras detectadas frame por frame por un',
            'modelo de visión que solo reconoce el alfabeto. Tu tarea es producir UNA SOLA',
            'frase en español natural que mejor explique esa secuencia.',
            '',
            'Reglas estrictas:',
            ' 1. Devuelve SOLO el texto final, sin comillas, sin explicaciones, sin prefijos.',
            ' 2. Corrige letras duplicadas o pegadas por mantenimiento de la seña (HHOLLA → hola).',
            ' 3. Inserta espacios y signos de puntuación donde tenga sentido en español.',
            ' 4. Si detectas saludos comunes (HOLA, BUENOS DIAS, GRACIAS, ADIOS), úsalos con tildes/signos correctos.',
            ' 5. Si la secuencia es incomprensible, devuelve exactamente la cadena: ???',
            ' 6. Nunca inventes contenido nuevo: solo reordena, corrige o puntúa lo dado.',
            ' 7. Idioma de salida: español (es-CO). Usa ¿? y ¡! cuando aplique.',
        ].join('\n');

        const userPrompt = opts.context
            ? `Contexto previo del usuario: """${opts.context}"""\n\nSecuencia detectada: """${rawSequence}"""`
            : `Secuencia detectada: """${rawSequence}"""`;

        const response = await llm.generateResponse(
            [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
            [],
            { primaryTimeoutMs: LLM_PRIMARY_TIMEOUT_MS },
        );

        const text = String(response?.content ?? '').trim();
        if (!text || text === '???') return null;
        // El LLM puede a veces devolver con comillas; las quitamos.
        return text.replace(/^["'`«»]+|["'`«»]+$/g, '').trim();
    } catch (err) {
        console.warn('[SignLanguage][composer] LLM falló:', err?.message || err);
        return null;
    }
}

/**
 * Compone la frase final a partir de una secuencia cruda.
 * Aplica primero la limpieza local; si el LLM responde, prefiere su
 * salida; si no, devuelve la versión local.
 *
 * @param {string} rawSequence
 * @param {{ context?: string, useLLM?: boolean }} [opts]
 * @returns {Promise<{ text: string, source: 'llm' | 'local', raw: string }>}
 */
export async function composePhrase(rawSequence, opts = {}) {
    const raw = String(rawSequence || '').trim();
    if (!raw) return { text: '', source: 'local', raw: '' };

    const local = cleanLocal(raw);
    if (opts.useLLM === false) return { text: local, source: 'local', raw };

    const llm = await llmCompose(raw, opts);
    if (llm) return { text: llm, source: 'llm', raw };
    return { text: local, source: 'local', raw };
}

/**
 * Finaliza una sesión: compone la frase a partir del draft y la borra.
 *
 * @param {string} id
 * @param {{ context?: string, useLLM?: boolean, keep?: boolean }} [opts]
 */
export async function finalizeSession(id, opts = {}) {
    const s = sessions.get(String(id || ''));
    if (!s) return { text: '', source: 'local', raw: '', draft: '' };
    const draft = buildDraft(s.events);
    const composed = await composePhrase(draft, opts);
    if (!opts.keep) sessions.delete(s.id);
    return { ...composed, draft };
}

export function getSessionDraft(id) {
    const s = sessions.get(String(id || ''));
    if (!s) return { draft: '', eventCount: 0 };
    return { draft: buildDraft(s.events), eventCount: s.events.length };
}
