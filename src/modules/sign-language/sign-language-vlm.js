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
    'CRITERIOS CUANTITATIVOS PARA "kind" (aplícalos en este orden y SIN ambigüedad).',
    'Esta clasificación es la fuente de mayor error en evaluaciones previas',
    '(letter↔number, word↔phrase, phrase↔sentence): respeta estas reglas al pie',
    'de la letra antes de decidir.',
    '  • "letter"   ⇢ text es UN SOLO carácter del alfabeto (A-Z, Ñ, vocales con',
    '                 tilde). La mano permanece estática o con micro-oscilación;',
    '                 NO hay trayectoria semántica. Si dudas entre letter y',
    '                 number, recuerda: las letras suelen apoyarse en la',
    '                 configuración del dactilológico (una sola mano, sin que los',
    '                 dedos cuenten una cantidad).',
    '  • "number"   ⇢ text son SOLO dígitos arábigos ("0"…"9", "10", "23",',
    '                 "100", "1000"). Los números se identifican por dedos',
    '                 extendidos contables (1-5 una mano, 6-9 configuraciones',
    '                 específicas, 10+ pueden usar dos manos o repetición).',
    '                 NUNCA escribas el número con palabras ("cinco") en este',
    '                 modo: usa la cifra.',
    '  • "word"     ⇢ text es UNA sola palabra léxica (sin espacios). Ej:',
    '                 "Hola", "Gracias", "Casa", "Agua", "Adiós". Si tu',
    '                 transcripción tiene espacios, NO es word.',
    '  • "phrase"   ⇢ text tiene 2-4 palabras y NO forma oración con sujeto+verbo',
    '                 conjugado. Ej: "Buenos días", "Por favor", "Muchas',
    '                 gracias", "Buenas noches". Saludos compuestos van aquí.',
    '  • "sentence" ⇢ text es una oración completa: incluye verbo conjugado, o',
    '                 cierra con punto/signo de interrogación/exclamación, o',
    '                 tiene 5+ palabras. Ej: "¿Cómo estás?", "Te amo mucho.",',
    '                 "Necesito ayuda por favor.", "Yo voy a la casa".',
    '  • "unknown"  ⇢ úsalo si confidence<0.3 o no hay señas claras. text="".',
    'Si tu candidato a kind no satisface su definición, REESCRIBE text o cambia',
    'kind para que sean COHERENTES. Por ejemplo: si vas a emitir kind="phrase"',
    'pero text es una sola palabra, baja a "word". Si vas a emitir kind="word"',
    'pero text contiene un verbo conjugado o un signo "¿?", sube a "sentence".',
    '',
    'Reglas estrictas de salida:',
    '  1. Devuelves UN ÚNICO objeto JSON, sin texto adicional, sin fences',
    '     ```json```, sin explicaciones fuera del JSON.',
    '  2. Esquema EXACTO (todos los campos obligatorios; usa null/[] cuando',
    '     no aplique pero NUNCA omitas la clave):',
    '     {',
    '       "text": string,                 // palabra/frase/número reconocido en español natural',
    '       "kind": "word"|"phrase"|"letter"|"number"|"sentence"|"unknown",',
    '       "confidence": number,           // 0.0 a 1.0',
    '       "alternatives": string[],       // hasta 2 alternativas plausibles',
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
    '     mayúscula. Esto incluye vocales (A, E, I, O, U) y consonantes.',
    '  5b. Si la seña representa un NÚMERO (0-9, decenas, centenas, miles), usa',
    '     kind="number" y text con el dígito o cifra en formato arábigo ("5",',
    '     "23", "1000"). Reconoce números formados con una o dos manos.',
    '  5c. Si la seña representa una ORACIÓN COMPLETA (sujeto + verbo, o varias',
    '     palabras encadenadas en un mismo flujo), usa kind="sentence" y text con',
    '     la oración completa correctamente puntuada en español.',
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
 *   kind: 'word'|'phrase'|'letter'|'number'|'sentence'|'unknown',
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
                opts.previousText
                    ? `Señas reconocidas inmediatamente antes en esta conversación: """${opts.previousText.slice(0, 300)}""". Úsalas SOLO como contexto para desambiguar, NO las repitas en tu respuesta.`
                    : null,
                `Recibes ${sampled.length} frames en orden cronológico (t0 → t${sampled.length - 1}).`,
                'Analiza la SECUENCIA como un clip de video corto: identifica AMBAS manos,',
                'la trayectoria del movimiento entre frames, contacto entre manos o con la',
                'cara, expresión facial y, a partir de todo eso, la INTENCIÓN comunicativa',
                '(afirmación, pregunta, exclamación, negación, saludo, agradecimiento, etc.).',
                'Aplica de forma estricta los CRITERIOS CUANTITATIVOS de "kind" definidos',
                'en las reglas del sistema: text y kind deben ser COHERENTES entre sí.',
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
    const kind = ['word', 'phrase', 'letter', 'number', 'sentence', 'unknown'].includes(kindRaw) ? kindRaw : 'unknown';
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

    // Reconcilia kind con la forma del texto: corrige el sesgo del VLM en
    // los límites letter↔number / word↔phrase / phrase↔sentence que la
    // matriz de confusión mostró como principales fuentes de error.
    const reconciled = reconcileKind(text, kind);

    return {
        text: reconciled.text,
        kind: reconciled.kind,
        kindRaw: kind,
        confidence,
        alternatives,
        handedness,
        motion,
        nonManual,
        reasoning,
        model,
    };
}

/**
 * Reglas determinísticas (puramente textuales) que reasignan `kind` a
 * partir de la forma de `text`. El VLM acierta el texto la mayoría de
 * veces, pero confunde la categoría — esta función arregla eso sin
 * llamadas adicionales.
 *
 * Orden de evaluación importa: va de lo más específico a lo más
 * general. Devuelve el texto normalizado (recortado) y el kind final.
 *
 * @param {string} rawText
 * @param {string} rawKind
 * @returns {{ text: string, kind: 'letter'|'number'|'word'|'phrase'|'sentence'|'unknown' }}
 */
export function reconcileKind(rawText, rawKind) {
    const text = String(rawText ?? '').trim();
    if (!text) return { text: '', kind: 'unknown' };

    // 1) Número puro (solo dígitos, opcionalmente con separador de miles).
    if (/^-?\d{1,3}(?:[.,]?\d{3})*$/.test(text) || /^-?\d+$/.test(text)) {
        return { text, kind: 'number' };
    }

    // 2) Letra única (alfabeto latino + Ñ + vocales con tilde + Ü).
    const chars = Array.from(text);
    if (chars.length === 1 && /^[A-ZÑÜÁÉÍÓÚ]$/i.test(chars[0])) {
        return { text: chars[0].toLocaleUpperCase('es'), kind: 'letter' };
    }

    // Cuenta de palabras léxicas (separadas por whitespace, ignorando
    // signos de puntuación sueltos).
    const tokens = text
        .replace(/[¡¿!?.,;:]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const wordCount = tokens.length;

    // Heurística de oración: tiene puntuación final, signo de
    // interrogación/exclamación, o un verbo conjugado típico en español.
    const hasSentencePunct = /[.!?¡¿]/.test(text);
    const verbHint = /\b(es|son|soy|eres|está|estoy|estás|estamos|están|hay|tengo|tienes|tiene|tenemos|tienen|quiero|quieres|quiere|necesito|necesitas|necesita|voy|vas|va|vamos|van|hago|haces|hace|hacemos|hacen|puedo|puedes|puede|amo|amas|ama|sé|sabes|sabe|gusta|gustan|llamo|llamas|llama|vivo|vives|vive)\b/i;

    // 3) Oración: 5+ palabras, o puntuación de cierre, o verbo conjugado.
    if (wordCount >= 5 || hasSentencePunct || verbHint.test(text)) {
        return { text, kind: 'sentence' };
    }

    // 4) Palabra única (sin espacios reales).
    if (wordCount <= 1) {
        return { text, kind: 'word' };
    }

    // 5) Resto (2-4 palabras, sin verbo, sin puntuación final): phrase.
    return { text, kind: 'phrase' };
}

/**
 * Reconoce una conversación larga segmentando un stream de frames en
 * clips independientes y llamando al VLM por cada uno. La segmentación
 * puede venir explícita (segments=[{start,end}]) o se hace por ventana
 * deslizante (windowSize, stride).
 *
 * Llamadas concurrentes acotadas por `concurrency` para no saturar el
 * proveedor. Las recogniciones consecutivas idénticas se colapsan.
 *
 * @param {Array<Buffer|string>} frames
 * @param {{
 *   segments?: Array<{ start: number, end: number }>,
 *   windowSize?: number,
 *   stride?: number,
 *   concurrency?: number,
 *   minConfidence?: number,
 *   context?: string,
 *   model?: string,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {Promise<{
 *   segments: Array<{ start: number, end: number, recognition: object|null }>,
 *   transcript: string,
 * }>}
 */
export async function recognizeSignStream(frames, opts = {}) {
    if (!Array.isArray(frames) || frames.length === 0) {
        throw Object.assign(new Error('Se requiere al menos un frame.'), {
            code: 'EMPTY_STREAM', statusCode: 400,
        });
    }
    const windowSize = clampInt(opts.windowSize, 2, MAX_FRAMES, 6);
    const stride = clampInt(opts.stride, 1, windowSize, Math.max(1, Math.floor(windowSize / 2)));
    const concurrency = clampInt(opts.concurrency, 1, 4, 2);
    const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.4;

    const segments = Array.isArray(opts.segments) && opts.segments.length
        ? opts.segments
            .map((s) => ({
                start: Math.max(0, Math.min(frames.length, Math.floor(s.start ?? 0))),
                end:   Math.max(0, Math.min(frames.length, Math.floor(s.end ?? 0))),
            }))
            .filter((s) => s.end - s.start >= MIN_FRAMES)
        : slidingWindows(frames.length, windowSize, stride);

    if (!segments.length) {
        return { segments: [], transcript: '' };
    }

    const results = new Array(segments.length).fill(null);
    let cursor = 0;
    let previousText = '';

    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= segments.length) return;
            const { start, end } = segments[i];
            const clip = frames.slice(start, end);
            if (clip.length < MIN_FRAMES) continue;
            try {
                const rec = await recognizeSignClip(clip, {
                    context: opts.context,
                    previousText,
                    model: opts.model,
                    timeoutMs: opts.timeoutMs,
                });
                results[i] = { start, end, recognition: rec };
                if (rec && rec.text && rec.kind !== 'unknown' && rec.confidence >= minConfidence) {
                    previousText = `${previousText} ${rec.text}`.trim().slice(-300);
                }
            } catch (err) {
                results[i] = { start, end, recognition: null, error: err?.message || String(err) };
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));

    // Colapsa recogniciones consecutivas idénticas y compone transcript.
    const transcriptParts = [];
    let lastText = '';
    for (const seg of results) {
        const rec = seg?.recognition;
        if (!rec || rec.kind === 'unknown' || !rec.text) continue;
        if (rec.confidence < minConfidence) continue;
        const t = rec.text.trim();
        if (!t || t === lastText) continue;
        transcriptParts.push(t);
        lastText = t;
    }

    return {
        segments: results,
        transcript: transcriptParts.join(' ').replace(/\s+([.,!?])/g, '$1').trim(),
    };
}

function slidingWindows(total, size, stride) {
    const out = [];
    if (total <= size) {
        out.push({ start: 0, end: total });
        return out;
    }
    for (let start = 0; start + Math.min(size, MIN_FRAMES) <= total; start += stride) {
        const end = Math.min(total, start + size);
        out.push({ start, end });
        if (end === total) break;
    }
    return out;
}

function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
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

export default { recognizeSignClip, recognizeSignStream, reconcileKind };
