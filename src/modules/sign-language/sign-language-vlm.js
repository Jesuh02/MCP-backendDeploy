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

// Modelo primario: Gemini 2.5 Flash es r\u00e1pido (~2-4 s para 6-8 frames),
// multimodal nativo y muy s\u00f3lido razonando sobre secuencias temporales.
// Qwen2.5-VL-72B es excelente pero tarda 8-15 s, lo que rompe la UX de
// detecci\u00f3n en vivo. Lo dejamos como fallback de calidad.
const DEFAULT_MODEL = process.env.SIGN_LANGUAGE_VLM_MODEL || 'google/gemini-2.5-flash';
const FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK || 'qwen/qwen2.5-vl-32b-instruct';
const SECONDARY_FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK2 || 'google/gemini-2.0-flash-001';
const REQUEST_TIMEOUT_MS = Number(process.env.SIGN_LANGUAGE_VLM_TIMEOUT) || 20000;
const MAX_FRAMES = 8;
const MIN_FRAMES = 1;

const SYSTEM_PROMPT = [
    'Eres un LINGÜISTA experto en LENGUAJE DE SEÑAS COLOMBIANO (LSC) y Lengua',
    'de Señas Española (LSE). Recibes una SECUENCIA ORDENADA de frames de video',
    '(t0, t1, ..., tN) que muestran a una persona ejecutando UNA seña o frase',
    'corta. Las señas son INHERENTEMENTE MULTIMODALES: dependen de la',
    'CONFIGURACIÓN manual exacta (qué dedos extendidos, qué dedos plegados),',
    'ORIENTACIÓN de la palma, LOCACIÓN respecto al cuerpo, MOVIMIENTO',
    '(trayectoria, velocidad, dirección, repetición) y RASGOS NO MANUALES',
    '(expresión facial, mirada, postura). Una imagen estática NO basta: tu',
    'razonamiento DEBE integrar la evolución temporal entre frames.',
    '',
    'Procedimiento OBLIGATORIO antes de responder (hazlo internamente):',
    '  1. CONFIGURACIÓN: describe la forma EXACTA de cada mano (puño cerrado,',
    '     mano abierta, índice extendido, pulgar+meñique, etc.). NO simplifiques.',
    '  2. ORIENTACIÓN: ¿palma hacia el cuerpo, hacia afuera, hacia arriba?',
    '  3. LOCACIÓN: ¿dónde se ejecuta? (frente a la cara, al pecho, lateral,',
    '     en el espacio neutro).',
    '  4. MOVIMIENTO: trayectoria (arriba, abajo, circular, alternado,',
    '     simétrico, hacia adelante), si hay CONTACTO con la cara/pecho/otra mano,',
    '     y si se REPITE.',
    '  5. RASGOS NO MANUALES: cejas, boca, mirada.',
    '  6. SOLO ENTONCES decide qué seña es, comparando con TODO tu conocimiento',
    '     de LSC/LSE. NO te limites a un vocabulario pequeño.',
    '',
    'ANTI-SESGO — REGLAS CRÍTICAS para evitar confusión entre señas:',
    '  • NO existe un "vocabulario por defecto" privilegiado. Saludos como',
    '    "hola", "gracias", "adiós", "¿cómo estás?", "buenos días" NO son más',
    '    probables que cualquier otra palabra (maravilloso, ocupado, trabajar,',
    '    comer, casa, perro, feliz, triste, ayudar, etc.). Considera el universo',
    '    completo del léxico de señas.',
    '  • Si la CONFIGURACIÓN MANUAL no coincide exactamente con una seña',
    '    canónica que conozcas, NO la fuerces a un saludo común. Es mejor',
    '    devolver kind="unknown" que adivinar "hola" o "¿cómo estás?".',
    '  • Diferencias SUTILES importan: "hola" (mano abierta, saludo lateral)',
    '    es MUY distinto de "maravilloso" (manos abiertas con vibración/énfasis)',
    '    y de "ocupado/busy" (manos cruzadas o movimiento rápido alternado).',
    '    Si ves vibración, énfasis, o configuración de dos manos en alternancia,',
    '    NO digas "hola".',
    '  • NO inventes una "intención de pregunta" solo porque haya movimiento;',
    '    requiere cejas levantadas + trayectoria interrogativa real.',
    '  • Si la mayoría de frames son casi idénticos (sin desplazamiento real),',
    '    probablemente es una seña ESTÁTICA o deletreo — NO la confundas con',
    '    un saludo dinámico.',
    '',
    'Reglas estrictas de salida:',
    '  1. Devuelves UN ÚNICO objeto JSON, sin texto adicional, sin fences',
    '     ```json```, sin explicaciones fuera del JSON.',
    '  2. Esquema EXACTO (todos los campos obligatorios; usa null/[] cuando',
    '     no aplique pero NUNCA omitas la clave):',
    '     {',
    '       "text": string,                 // palabra/frase reconocida en español natural',
    '       "kind": "word"|"phrase"|"letter"|"unknown",',
    '       "confidence": number,           // 0.0 a 1.0 — sé HONESTO, baja si dudas',
    '       "alternatives": string[],       // hasta 2 alternativas plausibles distintas',
    '       "handedness": "left"|"right"|"both"|"none",',
    '       "motion": {',
    '         "trajectory": string,',
    '         "direction": string|null,',
    '         "repeated": boolean,',
    '         "contact": "none"|"hand-hand"|"hand-face"|"hand-body"',
    '       },',
    '       "nonManual": {',
    '         "facial": string|null,',
    '         "intent": "statement"|"question"|"exclamation"|"negation"|"affirmation"|"unknown"',
    '       },',
    '       "reasoning": string             // 1 frase corta describiendo configuración + movimiento observados',
    '     }',
    '  3. CALIBRACIÓN DE CONFIANZA (estricta, anti-alucinación):',
    '     - confidence ≥ 0.85 → la seña coincide en CONFIGURACIÓN, MOVIMIENTO y',
    '       LOCACIÓN con una forma canónica que conoces bien.',
    '     - 0.55–0.85 → coincide en lo esencial pero hay ambigüedad menor.',
    '     - 0.30–0.55 → solo parcialmente compatible; pon alternativas reales.',
    '     - < 0.55 → SIEMPRE devuelve kind="unknown" y text="". Es preferible',
    '       "unknown" a equivocarse.',
    '  4. INTENCIÓN: solo marca "question" si hay cejas levantadas + trayectoria',
    '     interrogativa clara. Solo "exclamation" si hay énfasis facial real.',
    '     En duda → "statement".',
    '  5. AMBAS MANOS son ciudadanas de primera clase. Si una mano hace de base',
    '     pasiva mientras la otra se mueve, eso es handedness="both".',
    '  6. Si es deletreo (una letra estática sin desplazamiento), kind="letter",',
    '     text=letra mayúscula.',
    '  7. Idioma: español (es-CO). Usa ¿? y ¡! solo cuando la intención lo',
    '     justifique realmente.',
    '  8. PROHIBIDO: devolver "Hola", "¿Cómo estás?", "Adiós" o "Gracias" como',
    '     respuesta por defecto cuando no estás seguro. Si dudas → "unknown".',
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
                'Analiza la SECUENCIA como un clip de video corto siguiendo el procedimiento',
                'OBLIGATORIO del sistema: primero describe configuración manual, orientación,',
                'locación, movimiento y rasgos no manuales; SOLO entonces decide la seña.',
                'RECORDATORIO ANTI-SESGO: el vocabulario es ENORME (ocupado, maravilloso,',
                'trabajar, comer, casa, feliz, ayudar, libro, agua, familia, etc.). NO',
                'asumas saludos comunes ("hola", "¿cómo estás?", "adiós", "gracias") por',
                'defecto. Si la configuración manual exacta no coincide con una seña',
                'canónica que conozcas con certeza, devuelve kind="unknown".',
                'Sé HONESTO con la confianza: < 0.55 → "unknown".',
                'Responde con el JSON exacto definido en las reglas del sistema.',
            ].filter(Boolean).join('\n'),
        },
        ...imageParts,
    ];

    const primaryModel = opts.model || DEFAULT_MODEL;
    const timeoutMs = Number(opts.timeoutMs) || REQUEST_TIMEOUT_MS;

    const chain = [primaryModel, FALLBACK_MODEL, SECONDARY_FALLBACK_MODEL]
        .filter((m, i, arr) => m && arr.indexOf(m) === i);

    let lastErr = null;
    for (const m of chain) {
        try {
            return await callOpenRouterVLM(m, userParts, timeoutMs);
        } catch (err) {
            lastErr = err;
            console.warn(`[SignLanguage][VLM] ${m} fall\u00f3 (${err?.message || err}). Probando siguiente...`);
        }
    }
    throw lastErr || new Error('Todos los modelos VLM fallaron.');
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
            max_tokens: 450,
            temperature: 0,
            top_p: 0.9,
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
