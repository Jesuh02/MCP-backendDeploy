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

// Fix: orden de modelos por VELOCIDAD primero.
// gemini-2.0-flash-001 ~2-3 s con visión (logs mostraban 6-10 s con 2.5-flash).
// gemini-2.5-flash como fallback de calidad cuando el primario no responde.
// qwen2.5-vl-32b es muy bueno pero lento (8-15 s) → último recurso.
const DEFAULT_MODEL = process.env.SIGN_LANGUAGE_VLM_MODEL || 'google/gemini-2.0-flash-001';
const FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK || 'google/gemini-2.5-flash';
const SECONDARY_FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK2 || 'qwen/qwen2.5-vl-32b-instruct';
const REQUEST_TIMEOUT_MS = Number(process.env.SIGN_LANGUAGE_VLM_TIMEOUT) || 15000;
// MAX_FRAMES = 10 → suficiente evidencia temporal sin inflar el payload.
// 14 frames causaba 5-10 s de latencia en Gemini/Qwen. Con 10 frames bien
// espaciados se obtiene cobertura temporal equivalente con ~30% menos coste.
const MAX_FRAMES = 10;
const MIN_FRAMES = 1;

const SYSTEM_PROMPT = [
    'Eres un LINGÜISTA experto en LENGUAJE DE SEÑAS COLOMBIANO (LSC), Lengua',
    'de Señas Española (LSE) y American Sign Language (ASL). Recibes una',
    'SECUENCIA ORDENADA de frames de video',
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
    '    probables que cualquier otra palabra (maravilloso, ocupado/busy, fine,',
    '    trabajar, comer, casa, perro, feliz, triste, ayudar, sí, no, ok,',
    '    más o menos, qué pasa, no mucho, mi nombre es, parar, etc.). Considera',
    '    el universo COMPLETO del léxico de señas.',
    '  • Si la CONFIGURACIÓN MANUAL no coincide exactamente con una seña',
    '    canónica que conozcas, NO la fuerces a un saludo común. Es mejor',
    '    devolver kind="unknown" que adivinar "hola" o "¿cómo estás?".',
    '',
    '  PARES CONFUNDIBLES — léelos con MUCHA atención y NO los mezcles:',
    '    - "hola" = UNA mano abierta (B/5), palma hacia afuera, saludo lateral',
    '      suave cerca de la sien/frente. UNA sola mano. Sin vibración. Corto.',
    '    - "fine/bien" (ASL) = pulgar extendido tocando el pecho con los otros',
    '      dedos extendidos hacia arriba (configuración "5" con pulgar al',
    '      pecho). CONTACTO con el pecho. NO se parece a hola.',
    '    - "maravilloso/wonderful" = AMBAS manos abiertas (5/5), palmas hacia',
    '      afuera, sacudidas hacia adelante con énfasis. Si ves DOS manos',
    '      sacudiéndose hacia el frente, es maravilloso, NUNCA hola.',
    '    - "ocupado/busy" = mano en "B" o "5" oscilando rápido contra el pulgar',
    '      de la otra mano, movimiento CORTO y REPETIDO. NO es "parar".',
    '    - "parar/stop" = UNA palma vertical frontal golpeando o cayendo sobre',
    '      la otra palma horizontal. Movimiento ÚNICO descendente. NO oscila.',
    '    - "¿cómo estás?" = mano(s) en "5" con palmas hacia arriba, movimiento',
    '      de barrido lateral + CEJAS LEVANTADAS. Requiere cejas levantadas.',
    '    - "qué pasa / what\\u2019s up" = mano(s) en "5" palmas arriba con',
    '      encogimiento de hombros y cejas levantadas, movimiento corto. NO es',
    '      "¿cómo estás?".',
    '    - "mal/bad" = (a) mano plana en la boca girada 180° hacia abajo',
    '      (opuesto de "bueno"); o (b) pulgar hacia abajo. Si ves movimiento',
    '      hacia abajo o palma invertida NO lo confundas con "gracias" (que',
    '      mueve la mano HACIA AFUERA desde el mentón, sin inversión).',
    '    - "gracias" = mano plana tocando el mentón/labios y avanzando hacia',
    '      afuera. UN solo movimiento de salida desde la cara.',
    '    - "sí" = puño cerrado (S/A) asintiendo (movimiento vertical de la',
    '      muñeca, como cabeceo). MUY corto, pocos frames.',
    '    - "no" = índice+medio extendidos cerrándose contra el pulgar una o',
    '      dos veces. Corto.',
    '    - "ok" = pulgar e índice formando círculo, otros dedos extendidos.',
    '      Casi ESTÁTICO o leve giro de muñeca.',
    '    - "más o menos / so so" = mano abierta palma abajo balanceándose',
    '      lateralmente (oscilación de muñeca). NO es saludo.',
    '    - "no mucho" = manos en "flat-O" rozándose suavemente delante del',
    '      cuerpo, movimiento mínimo.',
    '    - "mi nombre es" = índice+medio (configuración H) tocando el dorso de',
    '      los mismos dedos de la otra mano (seña NAME). Suele preceder a',
    '      deletreo manual.',
    '',
    '  • Si ves vibración, énfasis, dos manos en alternancia o configuraciones',
    '    que no coinciden con "hola", NO digas "hola".',
    '  • NO inventes una "intención de pregunta" solo porque haya movimiento;',
    '    requiere cejas levantadas + trayectoria interrogativa real.',
    '  • Si la mayoría de frames son casi idénticos (sin desplazamiento real),',
    '    probablemente es una seña ESTÁTICA: deletreo de LETRA (A-Z) o NÚMERO',
    '    (0-9). NO la confundas con un saludo dinámico. Usa kind="letter" o',
    '    kind="number" según corresponda.',
    '  • NÚMEROS (0-9) tienen configuraciones canónicas (1=índice, 2=índice+',
    '    medio, 3=pulgar+índice+medio, 5=mano abierta, etc.). Si la mano está',
    '    estática en una configuración numérica, devuelve kind="number" y',
    '    text="0"..."9".',
    '',
    'Reglas estrictas de salida:',
    '  1. Devuelves UN ÚNICO objeto JSON, sin texto adicional, sin fences',
    '     ```json```, sin explicaciones fuera del JSON.',
    '  2. Esquema EXACTO (todos los campos obligatorios; usa null/[] cuando',
    '     no aplique pero NUNCA omitas la clave):',
    '     {',
    '       "text": string,                 // palabra/frase reconocida en español natural',
    '       "kind": "word"|"phrase"|"letter"|"number"|"unknown",  // number = d\u00edgito 0-9 est\u00e1tico',
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
    '     - 0.65–0.85 → coincide en lo esencial pero hay ambigüedad menor.',
    '     - 0.40–0.65 → solo parcialmente compatible; pon alternativas reales.',
    '     - < 0.65 → SIEMPRE devuelve kind="unknown" y text="". Es preferible',
    '       "unknown" a equivocarse. NUNCA adivines un saludo con confianza baja.',
    '  4. INTENCIÓN: solo marca "question" si hay cejas levantadas + trayectoria',
    '     interrogativa clara. Solo "exclamation" si hay énfasis facial real.',
    '     En duda → "statement".',
    '  5. AMBAS MANOS son ciudadanas de primera clase. Si una mano hace de base',
    '     pasiva mientras la otra se mueve, eso es handedness="both".',
    '  6. Si es deletreo (una letra estática sin desplazamiento), kind="letter",',
    '     text=letra mayúscula (A-Z). Si es un dígito (0-9 estático),',
    '     kind="number", text=dígito ("0".."9").',
    '  7. Idioma: español (es-CO). Usa ¿? y ¡! solo cuando la intención lo',
    '     justifique realmente.',
    '  8. PROHIBIDO: devolver "Hola", "¿Cómo estás?", "Adiós", "Gracias" o',
    '     "Buenos días" como respuesta por defecto cuando no estás seguro.',
    '     Si dudas incluso levemente → kind="unknown", text="".',
    '     Un false-positive de saludo ROMPE el sistema. Sé conservador.',
].join('\n');

/**
 * Reconoce la seña ejecutada en un clip de frames.
 *
 * @param {Array<Buffer|string>} frames - Buffers de imagen o data URLs.
 * @param {{ context?: string, model?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<null | {
 *   text: string,
 *   kind: 'word'|'phrase'|'letter'|'number'|'unknown',
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
                'RECORDATORIO ANTI-SESGO CRÍTICO: NO existe un vocabulario privilegiado.',
                'Saludos (hola, ¿cómo estás?, adiós, gracias, buenos días) son tan',
                'probables como: ocupado/busy, maravilloso/wonderful, fine/bien,',
                'mal/bad, parar/stop, sí, no, ok, más o menos/so-so, qué pasa,',
                'no mucho, mi nombre es, trabajar, comer, casa, feliz, agua, etc.',
                'Si la configuración manual exacta NO coincide con una seña que',
                'conozcas con CERTEZA → devuelve kind="unknown".',
                'Letra estática A-Z → kind="letter". Dígito estático 0-9 → kind="number".',
                'UMBRAL: confianza < 0.65 → kind="unknown", text="". Sin excepciones.',
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
            max_tokens: 600,
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
    const kind = ['word', 'phrase', 'letter', 'number', 'unknown'].includes(kindRaw) ? kindRaw : 'unknown';
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
