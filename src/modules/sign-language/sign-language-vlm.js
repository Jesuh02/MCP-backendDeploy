/**
 * sign-language-vlm.js — Reconocimiento de SEÑAS DINÁMICAS (palabras y
 * frases completas como "hola", "¿cómo estás?", "gracias", "buenos días")
 * usando un Vision-Language Model (VLM) multimodal vía OpenRouter.
 *
 * ¿Por qué existe este módulo?
 * ----------------------------
 * El pipeline ONNX local (`Alphabet-Sign-Language-Detection`) SOLO
 * clasifica imágenes estáticas del alfabeto A-Z. Por construcción, no
 * puede reconocer palabras (que son gestos en MOVIMIENTO). Cuando el
 * usuario hace la seña de "hola", el modelo estático solo ve "vocales
 * parecidas a la forma de la mano" → por eso la queja "solo detecta
 * vocales".
 *
 * Solución profesional: enviar una secuencia corta de frames (un "clip"
 * de 4-8 imágenes capturadas durante ~1-2 s) a un VLM con capacidad de
 * razonamiento sobre múltiples imágenes (Qwen2.5-VL, Llama-3.2-Vision,
 * Gemini-Flash, etc. — todos disponibles vía OpenRouter con la misma
 * API). El VLM identifica la seña ejecutada y responde JSON estricto.
 *
 * Layout de tarjeta de fallback: si OpenRouter no responde, devolvemos
 * `null` y el caller decide si caer a la pipeline de alfabeto.
 *
 * Variables de entorno:
 *   OPENROUTER_API_KEY         (obligatoria para el VLM)
 *   SIGN_LANGUAGE_VLM_MODEL    (default: "qwen/qwen2.5-vl-72b-instruct")
 *   SIGN_LANGUAGE_VLM_TIMEOUT  (ms, default 20000)
 *   SIGN_LANGUAGE_VLM_FALLBACK (modelo alterno si el primario falla;
 *                               default: "google/gemini-flash-1.5")
 */

import axios from 'axios';

const DEFAULT_MODEL = process.env.SIGN_LANGUAGE_VLM_MODEL || 'qwen/qwen2.5-vl-72b-instruct';
const FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK || 'google/gemini-flash-1.5';
const REQUEST_TIMEOUT_MS = Number(process.env.SIGN_LANGUAGE_VLM_TIMEOUT) || 20000;
const MAX_FRAMES = 8;
const MIN_FRAMES = 1;

const SYSTEM_PROMPT = [
    'Eres un experto LINGÜISTA en LENGUAJE DE SEÑAS COLOMBIANO (LSC) y Lengua',
    'de Señas Española (LSE). Recibes una SECUENCIA ORDENADA de frames de video',
    '(t0, t1, ..., tN) que muestran a una persona ejecutando UNA seña o frase',
    'corta. Las señas son INHERENTEMENTE MULTIMODALES: dependen de la',
    'configuración manual, ORIENTACIÓN, LOCACIÓN, MOVIMIENTO (trayectoria,',
    'velocidad, dirección, repetición) y RASGOS NO MANUALES (expresión facial,',
    'mirada, postura). Una imagen estática NO basta: tu razonamiento DEBE',
    'integrar la evolución temporal entre frames.',
    '',
    'Procedimiento OBLIGATORIO antes de responder:',
    '  1. Detecta cuántas manos participan (left, right, both) y si entran en',
    '     contacto entre sí o tocan la cara/cuerpo.',
    '  2. Describe internamente la TRAYECTORIA del movimiento (arriba, abajo,',
    '     circular, hacia adelante, alternado, simétrico, etc.).',
    '  3. Observa la EXPRESIÓN FACIAL y la CEJA: pregunta si las cejas suben',
    '     (interrogativa abierta tipo "¿cómo?"), bajan ("¿sí/no?"), o si los',
    '     labios marcan negación o intensidad.',
    '  4. Solo entonces decide qué palabra/frase está siendo señada.',
    '',
    'Reglas estrictas de salida:',
    '  1. Devuelves UN ÚNICO objeto JSON, sin texto adicional, sin fences',
    '     ```json```, sin explicaciones fuera del JSON.',
    '  2. Esquema EXACTO (todos los campos obligatorios; usa null/[] cuando',
    '     no aplique pero NUNCA omitas la clave):',
    '     {',
    '       "text": string,                 // palabra/frase reconocida en español natural',
    '       "kind": "word"|"phrase"|"letter"|"unknown",',
    '       "confidence": number,           // 0.0 a 1.0',
    '       "alternatives": string[],       // hasta 2 alternativas plausibles',
    '       "handedness": "left"|"right"|"both"|"none",',
    '       "motion": {                     // descripción del gesto observado',
    '         "trajectory": string,         // ej "circular", "lineal-arriba", "alternado"',
    '         "direction": string|null,     // "up"|"down"|"left"|"right"|"forward"|"none"|null',
    '         "repeated": boolean,          // ¿se repite la seña dentro del clip?',
    '         "contact": "none"|"hand-hand"|"hand-face"|"hand-body"',
    '       },',
    '       "nonManual": {                  // rasgos no manuales relevantes',
    '         "facial": string|null,        // ej "cejas-arriba", "labios-fruncidos", "neutra"',
    '         "intent": "statement"|"question"|"exclamation"|"negation"|"affirmation"|"unknown"',
    '       },',
    '       "reasoning": string             // 1 frase corta justificando la decisión',
    '     }',
    '  3. INTERPRETA LA INTENCIÓN del movimiento, no solo la forma:',
    '     - Si la trayectoria + expresión sugieren pregunta, usa nonManual.intent="question"',
    '       y aplica signos "¿…?" en text.',
    '     - Si es exclamación/saludo enfático, usa "exclamation" y "¡…!".',
    '     - Si es negación (sacudir la mano/cabeza), usa "negation".',
    '  4. AMBAS MANOS son ciudadanas de primera clase. Muchas señas (CASA,',
    '     LIBRO, GRACIAS, BUENOS-DÍAS, AYUDAR) requieren las dos. Si solo una',
    '     mano se mueve mientras la otra hace de base pasiva, eso TAMBIÉN cuenta',
    '     como handedness="both". No descartes la segunda mano por estar quieta.',
    '  5. Si la seña es solo deletreo del alfabeto (una sola letra estática,',
    '     sin desplazamiento significativo), usa kind="letter" y text=letra en',
    '     mayúscula.',
    '  6. Saludos/frases comunes deben salir CORRECTAMENTE PUNTUADOS:',
    '     "Hola", "Gracias", "Buenos días", "¿Cómo estás?", "Adiós", "Por',
    '     favor", "Sí", "No", "Te amo".',
    '  7. Si NO puedes identificar la seña con razonable certeza (confidence',
    '     < 0.3), usa kind="unknown" y text="". NUNCA inventes señas que no se',
    '     vean. Es preferible "unknown" a una adivinanza.',
    '  8. Idioma de salida: español (es-CO). Usa ¿? y ¡! cuando aplique.',
].join('\n');

/**
 * Reconoce la seña ejecutada en un clip de frames.
 *
 * @param {Array<Buffer|string>} frames - Buffers de imagen o data URLs.
 * @param {{ context?: string, model?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<null | {
 *   text: string,
 *   kind: 'word'|'phrase'|'letter'|'unknown',
 *   confidence: number,
 *   alternatives: string[],
 *   handedness: 'left'|'right'|'both'|'none',
 *   motion: {
 *     trajectory: string,
 *     direction: 'up'|'down'|'left'|'right'|'forward'|'backward'|'none'|null,
 *     repeated: boolean,
 *     contact: 'none'|'hand-hand'|'hand-face'|'hand-body',
 *   },
 *   nonManual: {
 *     facial: string|null,
 *     intent: 'statement'|'question'|'exclamation'|'negation'|'affirmation'|'unknown',
 *   },
 *   reasoning: string,
 *   model: string,
 * }>}
 */
export async function recognizeSignClip(frames, opts = {}) {
    if (!process.env.OPENROUTER_API_KEY) {
        throw Object.assign(new Error('OPENROUTER_API_KEY no está configurada.'), {
            code: 'VLM_NOT_CONFIGURED',
            statusCode: 503,
        });
    }
    if (!Array.isArray(frames) || frames.length < MIN_FRAMES) {
        throw Object.assign(new Error(`Se requieren al menos ${MIN_FRAMES} frame(s).`), {
            code: 'EMPTY_CLIP',
            statusCode: 400,
        });
    }

    // Submuestreo uniforme si vienen demasiados frames (manten coste acotado).
    const sampled = sampleEvenly(frames, MAX_FRAMES);
    const imageParts = sampled.map((f) => ({
        type: 'image_url',
        image_url: { url: toDataUrl(f) },
    }));

    const userParts = [
        {
            type: 'text',
            text: [
                opts.context
                    ? `Contexto previo del usuario: """${opts.context.slice(0, 300)}"""`
                    : null,
                `Recibes ${sampled.length} frames en orden cronológico (t0 → t${sampled.length - 1}).`,
                'Analiza la SECUENCIA como un clip de video corto: identifica AMBAS manos,',
                'la trayectoria del movimiento entre frames, contacto entre manos o con la',
                'cara, expresión facial y, a partir de todo eso, la INTENCIÓN comunicativa',
                '(afirmación, pregunta, exclamación, negación, saludo, agradecimiento, etc.).',
                'Responde con el JSON exacto definido en las reglas del sistema.',
            ].filter(Boolean).join('\n'),
        },
        ...imageParts,
    ];

    const primaryModel = opts.model || DEFAULT_MODEL;
    const timeoutMs = Number(opts.timeoutMs) || REQUEST_TIMEOUT_MS;

    try {
        return await callOpenRouterVLM(primaryModel, userParts, timeoutMs);
    } catch (err) {
        // Intentar con el modelo de respaldo si el primario explota (404, 5xx, timeout).
        if (FALLBACK_MODEL && FALLBACK_MODEL !== primaryModel) {
            console.warn(`[SignLanguage][VLM] ${primaryModel} falló (${err?.message || err}). Probando fallback ${FALLBACK_MODEL}.`);
            try {
                return await callOpenRouterVLM(FALLBACK_MODEL, userParts, timeoutMs);
            } catch (err2) {
                console.error('[SignLanguage][VLM] fallback también falló:', err2?.message || err2);
                throw err2;
            }
        }
        throw err;
    }
}

async function callOpenRouterVLM(model, userParts, timeoutMs) {
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userParts },
            ],
            max_tokens: 256,
            temperature: 0.1,
            response_format: { type: 'json_object' },
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://tareamov.com',
                'X-Title': 'Tareamov Sign Language',
            },
            timeout: timeoutMs,
        },
    );

    const raw = response.data?.choices?.[0]?.message?.content || '';
    const parsed = safeParseJson(raw);
    if (!parsed) {
        throw new Error(`Respuesta VLM no parseable: ${raw.slice(0, 120)}`);
    }

    const text = String(parsed.text ?? '').trim();
    const kindRaw = String(parsed.kind ?? 'unknown').toLowerCase();
    const kind = ['word', 'phrase', 'letter', 'unknown'].includes(kindRaw) ? kindRaw : 'unknown';
    const confidence = clamp01(Number(parsed.confidence));
    const alternatives = Array.isArray(parsed.alternatives)
        ? parsed.alternatives.filter((x) => typeof x === 'string').slice(0, 3)
        : [];

    const handednessRaw = String(parsed.handedness ?? 'none').toLowerCase();
    const handedness = ['left', 'right', 'both', 'none'].includes(handednessRaw) ? handednessRaw : 'none';

    const motionRaw = (parsed && typeof parsed.motion === 'object' && parsed.motion) || {};
    const contactRaw = String(motionRaw.contact ?? 'none').toLowerCase();
    const directionRaw = motionRaw.direction == null ? null : String(motionRaw.direction).toLowerCase();
    const motion = {
        trajectory: typeof motionRaw.trajectory === 'string' ? motionRaw.trajectory.slice(0, 80) : '',
        direction: ['up', 'down', 'left', 'right', 'forward', 'backward', 'none', null].includes(directionRaw)
            ? directionRaw
            : null,
        repeated: Boolean(motionRaw.repeated),
        contact: ['none', 'hand-hand', 'hand-face', 'hand-body'].includes(contactRaw) ? contactRaw : 'none',
    };

    const nonManualRaw = (parsed && typeof parsed.nonManual === 'object' && parsed.nonManual) || {};
    const intentRaw = String(nonManualRaw.intent ?? 'unknown').toLowerCase();
    const nonManual = {
        facial: typeof nonManualRaw.facial === 'string' ? nonManualRaw.facial.slice(0, 60) : null,
        intent: ['statement', 'question', 'exclamation', 'negation', 'affirmation', 'unknown'].includes(intentRaw)
            ? intentRaw
            : 'unknown',
    };

    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 240) : '';

    return { text, kind, confidence, alternatives, handedness, motion, nonManual, reasoning, model };
}

/**
 * @param {Buffer|string} frame
 * @returns {string} data URL
 */
function toDataUrl(frame) {
    if (Buffer.isBuffer(frame)) {
        const mime = detectMime(frame);
        return `data:${mime};base64,${frame.toString('base64')}`;
    }
    if (typeof frame === 'string') {
        if (frame.startsWith('data:')) return frame;
        return `data:image/jpeg;base64,${frame.replace(/^.*?,/, '')}`;
    }
    throw new Error('Frame inválido: se esperaba Buffer o string base64.');
}

function detectMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (
        buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp';
    return 'image/jpeg';
}

function sampleEvenly(arr, k) {
    if (arr.length <= k) return arr.slice();
    const out = [];
    const step = (arr.length - 1) / (k - 1);
    for (let i = 0; i < k; i++) out.push(arr[Math.round(i * step)]);
    return out;
}

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function safeParseJson(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch { /* try to strip fences */ }
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        return JSON.parse(m[0]);
    } catch {
        return null;
    }
}

export default { recognizeSignClip };
