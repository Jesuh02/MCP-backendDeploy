/**
 * sign-language-vlm.js — Reconocimiento de SEÑAS DINÁMICAS (palabras y
 * frases completas ASL en inglés como "hello", "how are you?", "thank you")
 * usando un Vision-Language Model (VLM) multimodal vía OpenRouter.
 *
 * ¿Por qué existe este módulo?
 * ----------------------------
 * El pipeline ONNX local (`Alphabet-Sign-Language-Detection`) SOLO
 * clasifica imágenes estáticas del alfabeto A-Z. Por construcción, no
 * puede reconocer palabras (que son gestos en MOVIMIENTO). Cuando el
 * usuario hace la seña de "hello", el modelo estático solo ve "vocales
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
 *   SIGN_LANGUAGE_PROFILE      "asl" por defecto; usar "lsc" para LSC/español.
 */

import axios from 'axios';
import { computeThumbnail, motionScore } from './motion-detector.js';

// Orden de modelos por disponibilidad + calidad observada en OpenRouter.
// `google/gemini-2.0-flash-001` devolvio 404 en la prueba real de video, así
// que no debe ser el default: agregaba una llamada fallida antes de cada
// reconocimiento. Gemini 2.5 Flash respondio correctamente y mantiene buena
// latencia para clips cortos.
const DEFAULT_MODEL = process.env.SIGN_LANGUAGE_VLM_MODEL || 'google/gemini-2.5-flash';
const FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK || 'openai/gpt-4o';
const SECONDARY_FALLBACK_MODEL = process.env.SIGN_LANGUAGE_VLM_FALLBACK2 || 'qwen/qwen2.5-vl-32b-instruct';
const REQUEST_TIMEOUT_MS = Number(process.env.SIGN_LANGUAGE_VLM_TIMEOUT) || 15000;
// 14 frames conserva mejor trayectoria de manos en clips dinamicos sin mandar
// el video completo al VLM.
const MAX_FRAMES = 14;
const MIN_FRAMES = 1;
const STREAM_DEFAULT_FRAME_INTERVAL_MS = 250;
const STREAM_MOTION_HIGH = 0.030;
const STREAM_MOTION_LOW = 0.010;
const STREAM_SETTLE_MS = 350;
const STREAM_MIN_MOTION_MS = 450;
const STREAM_MIN_STATIC_MS = 900;
const STREAM_PRE_ROLL_MS = 200;
const STREAM_POST_ROLL_MS = 200;
const STREAM_MAX_SEGMENT_FRAMES = 16;
const TIMELINE_WINDOW_MS = 30_000;
const TIMELINE_MAX_FRAMES_PER_WINDOW = 18;
const TIMELINE_MIN_GAP_DUPLICATE_MS = 3_000;

const LSC_BASIC_VOCABULARY = [
    'Sordo',
    '¿Cómo?',
    '¿Cuándo?',
    '¿Dónde?',
    '¿Por qué?',
    '¿Qué?',
    '¿Quién?',
    'Hola',
    '¿Cómo estás?',
    'Bien',
    'Bueno',
    'Mal',
    'Malo',
    'Más o menos',
    'Buenos días',
    'Buenas tardes',
    'Buenas noches',
    'Adiós',
    'Por favor',
    'Con gusto',
    'Bienvenido',
    'Gracias',
    'Perdón',
    'Permiso',
    'Lo siento',
    'Feliz',
    'Feliz cumpleaños',
    'Feliz Navidad',
];

const LSC_REFERENCE_PROMPT = [
    'OBJETIVO PRINCIPAL: Lengua de Señas Colombiana (LSC), español de Colombia.',
    'Usa LSE/ASL solo como respaldo secundario y NUNCA cuando contradigan una glosa LSC.',
    'Glosas LSC prioritarias del DBLSC para fórmulas de cortesía y saludos:',
    '  - DECIR-HOLA -> "Hola"',
    '  - ¿CÓMO-ESTAR? -> "¿Cómo estás?"',
    '  - AGRADECER / DECIR-GRACIAS / GRACIAS-A -> "Gracias"',
    '  - BUENAS-TARDES -> "Buenas tardes"',
    '  - BUENOS-DÍAS -> "Buenos días"',
    '  - BUENAS-NOCHES -> "Buenas noches"',
    '  - DECIR-ADIÓS -> "Adiós"',
    '  - COMO / PREGUNTAR-COMO -> "¿Cómo?"',
    '  - CUANDO / PREGUNTAR-CUANDO -> "¿Cuándo?"',
    '  - DONDE / PREGUNTAR-DONDE -> "¿Dónde?"',
    '  - POR-QUE / PREGUNTAR-POR-QUE -> "¿Por qué?"',
    '  - QUE / PREGUNTAR-QUE -> "¿Qué?"',
    '  - QUIEN / PREGUNTAR-QUIEN -> "¿Quién?"',
    '  - BIEN -> "Bien" o, en respuesta a una pregunta, "Estoy bien"',
    '  - BUENO -> "Bueno"',
    '  - MALO -> "Malo"',
    '  - POR-FAVOR -> "Por favor"',
    '  - CON-GUSTO -> "Con gusto"',
    '  - BIENVENIDO / BIENVENIDOS -> "Bienvenido"',
    '  - PERDONAR / PEDIR-PERDÓN -> "Perdón"',
    '  - PERMISO -> "Permiso"',
    '  - LO-SIENTO -> "Lo siento"',
    '  - FELIZ -> "Feliz"',
    '  - FELIZ-CUMPLEAÑOS -> "Feliz cumpleaños"',
    '  - FELIZ-NAVIDAD -> "Feliz Navidad"',
    '',
    'ERRORES CRÍTICOS QUE DEBES EVITAR EN LSC:',
    '  - No confundas DECIR-HOLA con ¿CÓMO-ESTAR?: hola es saludo; ¿cómo estás?',
    '    requiere intención interrogativa, rasgos no manuales de pregunta y flujo de pregunta.',
    '  - No conviertas preguntas aisladas (¿Cómo?, ¿Cuándo?, ¿Dónde?, ¿Por qué?,',
    '    ¿Qué?, ¿Quién?) en saludos u oraciones completas. Si el clip muestra',
    '    una sola palabra interrogativa, responde esa palabra exacta.',
    '  - No confundas BIEN / ESTOY BIEN con GRACIAS: gracias pertenece a la familia',
    '    AGRADECER/DECIR-GRACIAS/GRACIAS-A; si ves configuración o contacto propio',
    '    de BIEN y no un acto de agradecer, responde "Estoy bien" o "Bien".',
    '  - No confundas ¿CÓMO-ESTAR? con TE AMO: "Te amo" requiere una configuración',
    '    manual claramente amor/ILY/corazón/afecto; si hay pregunta, cejas levantadas',
    '    o saludo conversacional, NO respondas "Te amo".',
    '  - BUENAS-TARDES, BUENOS-DÍAS y BUENAS-NOCHES son frases de cortesía válidas;',
    '    no las reduzcas a "Hola" ni a "Gracias" si el clip muestra saludo compuesto.',
    '  - No confundas LO-SIENTO con TE AMO: lo siento suele usar contacto o movimiento',
    '    sobre el pecho/corazón con expresión de disculpa; "Te amo" requiere señal',
    '    afectiva inequívoca, ILY/corazón o declaración de amor.',
    '  - No confundas POR-FAVOR, PERDÓN, PERMISO y LO-SIENTO: todos pueden estar cerca',
    '    del torso o rostro, pero representan intenciones distintas de cortesía.',
].join('\n');

const LSC_TEXT_NORMALIZATIONS = new Map([
    ['decir hola', 'Hola'],
    ['hola', 'Hola'],
    ['como', '¿Cómo?'],
    ['cómo', '¿Cómo?'],
    ['cuando', '¿Cuándo?'],
    ['cuándo', '¿Cuándo?'],
    ['donde', '¿Dónde?'],
    ['dónde', '¿Dónde?'],
    ['por que', '¿Por qué?'],
    ['por qué', '¿Por qué?'],
    ['por-que', '¿Por qué?'],
    ['que', '¿Qué?'],
    ['qué', '¿Qué?'],
    ['quien', '¿Quién?'],
    ['quién', '¿Quién?'],
    ['como estar', '¿Cómo estás?'],
    ['cómo estar', '¿Cómo estás?'],
    ['como estas', '¿Cómo estás?'],
    ['como estás', '¿Cómo estás?'],
    ['cómo estas', '¿Cómo estás?'],
    ['cómo estás', '¿Cómo estás?'],
    ['agradecer', 'Gracias'],
    ['decir gracias', 'Gracias'],
    ['gracias a', 'Gracias'],
    ['gracias-a', 'Gracias'],
    ['gracias', 'Gracias'],
    ['buenas tardes', 'Buenas tardes'],
    ['buenas-tardes', 'Buenas tardes'],
    ['buenos dias', 'Buenos días'],
    ['buenos días', 'Buenos días'],
    ['buenos-días', 'Buenos días'],
    ['buenas noches', 'Buenas noches'],
    ['buenas-noches', 'Buenas noches'],
    ['decir adios', 'Adiós'],
    ['decir adiós', 'Adiós'],
    ['adios', 'Adiós'],
    ['adiós', 'Adiós'],
    ['bien', 'Bien'],
    ['bueno', 'Bueno'],
    ['malo', 'Malo'],
    ['estoy bien', 'Estoy bien'],
    ['yo estoy bien', 'Estoy bien'],
    ['sordo', 'Sordo'],
    ['mas o menos', 'Más o menos'],
    ['más o menos', 'Más o menos'],
    ['mas-o-menos', 'Más o menos'],
    ['maravilloso', 'Maravilloso'],
    ['por favor', 'Por favor'],
    ['por-favor', 'Por favor'],
    ['con gusto', 'Con gusto'],
    ['con-gusto', 'Con gusto'],
    ['bienvenido', 'Bienvenido'],
    ['bienvenidos', 'Bienvenido'],
    ['perdon', 'Perdón'],
    ['perdón', 'Perdón'],
    ['pedir perdon', 'Perdón'],
    ['pedir perdón', 'Perdón'],
    ['pedir-perdón', 'Perdón'],
    ['permiso', 'Permiso'],
    ['lo siento', 'Lo siento'],
    ['lo-siento', 'Lo siento'],
    ['feliz', 'Feliz'],
    ['feliz cumpleanos', 'Feliz cumpleaños'],
    ['feliz cumpleaños', 'Feliz cumpleaños'],
    ['feliz-cumpleaños', 'Feliz cumpleaños'],
    ['feliz navidad', 'Feliz Navidad'],
    ['feliz-navidad', 'Feliz Navidad'],
    ['te amo', 'Te amo'],
]);

const ASL_BASIC_VOCABULARY = [
    'Hello',
    'Hi',
    'How are you?',
    'I am fine.',
    'Fine',
    'Good',
    'Bad',
    'Good morning',
    'Good afternoon',
    'Good night',
    'Goodbye',
    'Thank you',
    'Please',
    'Sorry',
    'Excuse me',
    'I love you',
    'Yes',
    'No',
    'Okay',
    'What?',
    'Where?',
    'Who?',
    'When?',
    'Why?',
    'How?',
    'Help',
    'Want',
    'Need',
    'Home',
    'School',
    'Work',
    'Eat',
    'Drink',
    'Water',
    'Bathroom',
    'Friend',
    'Teacher',
    'Student',
    'Understand',
    "I don't understand.",
    'Again',
    'Finish',
    'My name is',
    'Nice to meet you',
    'Busy',
    'Wonderful',
    'So-so',
    'Nothing much',
    'Stop',
];

const ASL_TEXT_NORMALIZATIONS = new Map([
    ['hello', 'Hello'],
    ['hi', 'Hi'],
    ['asl hello', 'Hello'],
    ['how are you', 'How are you?'],
    ['how you', 'How are you?'],
    ['how-you', 'How are you?'],
    ['how are you doing', 'How are you?'],
    ['whats up', "What's up?"],
    ["what's up", "What's up?"],
    ['what up', "What's up?"],
    ['i am fine', 'I am fine.'],
    ["i'm fine", 'I am fine.'],
    ['im fine', 'I am fine.'],
    ['fine', 'Fine'],
    ['good', 'Good'],
    ['bad', 'Bad'],
    ['good morning', 'Good morning'],
    ['good-morning', 'Good morning'],
    ['good afternoon', 'Good afternoon'],
    ['good-afternoon', 'Good afternoon'],
    ['good night', 'Good night'],
    ['good-night', 'Good night'],
    ['goodbye', 'Goodbye'],
    ['good bye', 'Goodbye'],
    ['bye', 'Goodbye'],
    ['thank you', 'Thank you'],
    ['thank-you', 'Thank you'],
    ['thanks', 'Thank you'],
    ['please', 'Please'],
    ['sorry', 'Sorry'],
    ['excuse me', 'Excuse me'],
    ['excuse-me', 'Excuse me'],
    ['i love you', 'I love you.'],
    ['ily', 'I love you.'],
    ['yes', 'Yes'],
    ['no', 'No'],
    ['ok', 'Okay'],
    ['okay', 'Okay'],
    ['what', 'What?'],
    ['where', 'Where?'],
    ['who', 'Who?'],
    ['when', 'When?'],
    ['why', 'Why?'],
    ['how', 'How?'],
    ['help', 'Help'],
    ['want', 'Want'],
    ['need', 'Need'],
    ['home', 'Home'],
    ['school', 'School'],
    ['work', 'Work'],
    ['eat', 'Eat'],
    ['drink', 'Drink'],
    ['water', 'Water'],
    ['bathroom', 'Bathroom'],
    ['friend', 'Friend'],
    ['teacher', 'Teacher'],
    ['student', 'Student'],
    ['understand', 'Understand'],
    ['i dont understand', "I don't understand."],
    ["i don't understand", "I don't understand."],
    ['dont understand', "I don't understand."],
    ["don't understand", "I don't understand."],
    ['again', 'Again'],
    ['finish', 'Finish'],
    ['my name is', 'My name is'],
    ['name', 'Name'],
    ['nice to meet you', 'Nice to meet you.'],
    ['busy', 'Busy'],
    ['wonderful', 'Wonderful'],
    ['so so', 'So-so'],
    ['so-so', 'So-so'],
    ['nothing much', 'Nothing much'],
    ['stop', 'Stop'],
]);

const ASL_SYSTEM_PROMPT = [
    'You are an expert American Sign Language (ASL) linguist and visual interpreter.',
    'Your output language is English (en-US). Do not translate ASL signs into Spanish.',
    'You receive an ordered sequence of camera frames (t0, t1, ..., tN) that may show',
    'a single static handshape, a number, a word, a phrase, or a short sentence.',
    'ASL is multimodal: you must integrate handshape, palm orientation, location,',
    'movement path, repetition, contact, both hands, gaze, eyebrows, mouth morphemes,',
    'head movement, and body posture across the whole clip.',
    '',
    'Required internal procedure before returning JSON:',
    '  1. Identify the exact handshape of each hand: fist, flat-B, open-5, index,',
    '     index+middle, ILY handshape, O, C, bent fingers, etc.',
    '  2. Identify palm orientation: inward, outward, up, down, side.',
    '  3. Identify location: forehead, chin, mouth, chest, neutral space, one hand',
    '     contacting the other, or both hands moving.',
    '  4. Identify motion: direction, arc, circle, repeated movement, tapping, twist,',
    '     wrist nod, opening/closing, or no semantic movement.',
    '  5. Identify non-manual markers: raised eyebrows for yes/no or wh questions,',
    '     head shake for negation, facial affect, mouth morphemes.',
    '  6. Decide the sign only after comparing these cues against ASL, not against LSC/LSE.',
    '',
    'ASL priority lexicon and anti-confusion rules:',
    '  - HELLO/HI: one open hand near the forehead/temple, palm outward, short side wave.',
    '    Do not upgrade it to "How are you?" unless there is clear question expression',
    '    and an ASL question/you-directed movement.',
    '  - HOW ARE YOU: ASL HOW + YOU / conversational question, usually with raised',
    '    eyebrows and directed movement. It must output "How are you?".',
    '  - THANK YOU: flat hand from chin/lips moving outward. If the hand does not start',
    '    at chin/lips/face, do not guess "Thank you".',
    '  - GOOD/FINE/I AM FINE: positive state signs are not THANK YOU unless there is',
    '    chin/lip contact and outward gratitude movement.',
    '  - PLEASE: open flat hand circles on chest. Do not confuse with SORRY.',
    '  - SORRY: fist circles on chest. Do not confuse with PLEASE.',
    '  - I LOVE YOU: requires a clear ILY handshape or explicit love/heart sign. Do not',
    '    confuse it with HOW ARE YOU, HELLO, or static letter Y/I/L shapes.',
    '  - YES: S/A fist nodding at the wrist. NO: index+middle closing to thumb.',
    '  - OKAY/OK: thumb and index form a circle with other fingers extended.',
    '  - SO-SO: open flat hand palm down rocking side to side.',
    '  - BUSY: repeated short movement against the other hand/thumb area. Do not call it STOP.',
    '  - STOP: one vertical palm strikes or drops onto a horizontal palm once.',
    '  - If most frames are nearly identical and there is no semantic path, treat it as',
    '    static fingerspelling or a number, not as a dynamic greeting.',
    '  - Numbers must be returned as Arabic digits, for example "0", "5", "23", "100".',
    '',
    'Kind rules, applied in this order:',
    '  - "letter": text is exactly one uppercase A-Z letter. Use this for static',
    '    ASL fingerspelling letters, including vowels A, E, I, O, U.',
    '  - "number": text is only Arabic digits. Use digits, not number words.',
    '  - "word": one lexical English word with no spaces, for example "Hello", "Work".',
    '  - "phrase": 2-4 English words that are not a full subject+verb sentence,',
    '    for example "Good morning", "Thank you", "My name is".',
    '  - "sentence": a complete English sentence or question, or 5+ words, for example',
    '    "How are you?", "I am fine.", "I need help.", "I love you.".',
    '  - "unknown": confidence < 0.3 or unclear signing. Return text="".',
    '',
    'Strict JSON response:',
    '  1. Return exactly one JSON object and no markdown fences.',
    '  2. Required schema:',
    '     {',
    '       "text": string,',
    '       "kind": "word"|"phrase"|"letter"|"number"|"sentence"|"unknown",',
    '       "confidence": number,',
    '       "alternatives": string[],',
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
    '       "reasoning": string',
    '     }',
    '  3. If you are not visually sure, return kind="unknown" instead of guessing.',
    '  4. Output English text with normal capitalization and punctuation.',
].join('\n');

const SYSTEM_PROMPT = [
    'Eres un LINGÜISTA experto en LENGUAJE DE SEÑAS COLOMBIANO (LSC).',
    'Conoces LSE y ASL solo para evitar falsos cognados, pero tu salida debe',
    'priorizar LSC y español de Colombia. Recibes una',
    'SECUENCIA ORDENADA de frames de video',
    'El clip puede ser una letra, un número, una palabra, una frase o una',
    'oración corta con varias señas encadenadas en un mismo flujo.',
    '(t0, t1, ..., tN) que muestran una unidad comunicativa completa.',
    'Las señas son INHERENTEMENTE MULTIMODALES: dependen de la',
    'CONFIGURACIÓN manual exacta (qué dedos extendidos, qué dedos plegados),',
    'ORIENTACIÓN de la palma, LOCACIÓN respecto al cuerpo, MOVIMIENTO',
    '(trayectoria, velocidad, dirección, repetición) y RASGOS NO MANUALES',
    '(expresión facial, mirada, postura). Una imagen estática NO basta: tu',
    'razonamiento DEBE integrar la evolución temporal entre frames.',
    '',
    LSC_REFERENCE_PROMPT,
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
    '  6. SOLO ENTONCES decide qué seña es, comparando primero contra LSC.',
    '     NO te limites a un vocabulario pequeño ni fuerces ASL/LSE sobre LSC.',
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
    '      Si no hay cejas levantadas ni estructura interrogativa, NO lo subas a',
    '      "¿Cómo estás?".',
    '    - "buenas tardes" = saludo compuesto de cortesía LSC (BUENAS-TARDES).',
    '      Si ves dos unidades de saludo/cortesía encadenadas, responde la frase',
    '      completa "Buenas tardes", no "Hola" ni "Gracias".',
    '    - "bien / estoy bien" (LSC: BIEN) = estado positivo o respuesta a',
    '      ¿CÓMO-ESTAR?. No lo conviertas en "Gracias" si no hay contacto/salida',
    '      desde boca, mentón o cara propio de AGRADECER/DECIR-GRACIAS.',
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
    '      Si el gesto no nace en boca/mentón/cara, NO digas "Gracias".',
    '    - "bien / estoy bien" = estado positivo/respuesta conversacional. En LSC',
    '      BIEN puede aparecer como respuesta a ¿CÓMO-ESTAR?; no la confundas con',
    '      AGRADECER/DECIR-GRACIAS/GRACIAS-A si no hay acto de agradecer.',
    '    - "te amo" = afecto/amor. Requiere configuración manual inequívoca de',
    '      amor/ILY/corazón/afecto. NO lo confundas con ¿CÓMO-ESTAR? ni con',
    '      saludos si el clip muestra pregunta o cortesía conversacional.',
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
    '     "Hola", "Gracias", "Buenos días", "Buenas tardes", "Buenas noches",',
    '     "¿Cómo estás?", "Estoy bien", "Adiós", "Por favor", "Sí", "No",',
    '     "Te amo".',
    '  7. Si NO puedes identificar la seña con razonable certeza (confidence',
    '     < 0.3), usa kind="unknown" y text="". NUNCA inventes señas que no se',
    '     vean. Es preferible "unknown" a una adivinanza.',
    '  8. Idioma de salida: español (es-CO). Usa ¿? y ¡! cuando aplique.',
].join('\n');

function resolveSignLanguageProfile(raw) {
    const value = String(
        raw ||
        process.env.SIGN_LANGUAGE_PROFILE ||
        process.env.SIGN_LANGUAGE_VARIANT ||
        process.env.SIGN_LANGUAGE_LANGUAGE ||
        'asl',
    ).trim().toLowerCase();
    if (['lsc', 'es', 'es-co', 'spanish', 'colombian', 'colombia', 'lengua-de-senas-colombiana'].includes(value)) {
        return 'lsc';
    }
    return 'asl';
}

function buildSystemPrompt(language) {
    return resolveSignLanguageProfile(language) === 'lsc'
        ? SYSTEM_PROMPT
        : ASL_SYSTEM_PROMPT;
}

function buildPreviousTextInstruction(previousText, language) {
    if (!previousText) return null;
    const text = String(previousText).slice(0, 300);
    if (resolveSignLanguageProfile(language) === 'lsc') {
        return `Señas reconocidas inmediatamente antes en esta conversación: """${text}""". Úsalas SOLO como contexto para desambiguar, NO las repitas en tu respuesta.`;
    }
    return `Signs recognized immediately before this turn: """${text}""". Use them only as context for disambiguation; do not repeat them unless the signer signs them again.`;
}

function buildContextInstruction(context, language) {
    if (!context) return null;
    const text = String(context).slice(0, 300);
    if (resolveSignLanguageProfile(language) === 'lsc') {
        return `Contexto previo del usuario: """${text}"""`;
    }
    return `User context: """${text}"""`;
}

function buildClipPrompt(opts, frameCount, language) {
    if (resolveSignLanguageProfile(language) === 'lsc') {
        return [
            buildContextInstruction(opts.context, language),
            buildPreviousTextInstruction(opts.previousText, language),
            buildVocabularyInstruction(opts.vocabulary, language),
            buildModeInstruction(opts.mode, language),
            `Recibes ${frameCount} frames en orden cronológico (t0 -> t${frameCount - 1}).`,
            'Analiza la SECUENCIA como un clip de video corto: identifica AMBAS manos,',
            'la trayectoria del movimiento entre frames, contacto entre manos o con la',
            'cara, expresión facial y, a partir de todo eso, la INTENCIÓN comunicativa',
            '(afirmación, pregunta, exclamación, negación, saludo, agradecimiento, etc.).',
            'Aplica de forma estricta los CRITERIOS CUANTITATIVOS de "kind" definidos',
            'en las reglas del sistema: text y kind deben ser COHERENTES entre sí.',
            'Responde con el JSON exacto definido en las reglas del sistema.',
        ].filter(Boolean).join('\n');
    }

    return [
        buildContextInstruction(opts.context, language),
        buildPreviousTextInstruction(opts.previousText, language),
        buildVocabularyInstruction(opts.vocabulary, language),
        buildModeInstruction(opts.mode, language),
        `You receive ${frameCount} frames in chronological order (t0 -> t${frameCount - 1}).`,
        'Analyze the whole sequence as a short ASL video clip. Identify both hands,',
        'the motion path between frames, hand-face or hand-body contact, facial',
        'expression, gaze, and communicative intent.',
        'Apply the strict "kind" rules from the system prompt. The text and kind',
        'must be coherent with each other.',
        'Return exactly the JSON object required by the system prompt.',
    ].filter(Boolean).join('\n');
}

/**
 * Reconoce la seña ejecutada en un clip de frames.
 *
 * @param {Array<Buffer|string>} frames - Buffers de imagen o data URLs.
 * @param {{ context?: string, previousText?: string, mode?: 'static'|'dynamic'|'sentence', model?: string, timeoutMs?: number, vocabulary?: string[], language?: 'asl'|'lsc'|string }} [opts]
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

    const language = resolveSignLanguageProfile(opts.language);

    // Submuestreo uniforme si vienen demasiados frames (manten coste acotado).
    const sampled = sampleEvenly(frames, MAX_FRAMES);
    const imageParts = sampled.map((f) => ({
        type: 'image_url',
        image_url: { url: toDataUrl(f) },
    }));

    const userParts = [
        {
            type: 'text',
            text: buildClipPrompt(opts, sampled.length, language),
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
            return await callOpenRouterVLM(m, userParts, timeoutMs, { language });
        } catch (err) {
            lastErr = err;
            console.warn(`[SignLanguage][VLM] ${m} fall\u00f3 (${err?.message || err}). Probando siguiente...`);
        }
    }
    throw lastErr || new Error('Todos los modelos VLM fallaron.');
}

async function callOpenRouterVLM(model, userParts, timeoutMs, opts = {}) {
    const language = resolveSignLanguageProfile(opts.language);
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            model,
            messages: [
                { role: 'system', content: buildSystemPrompt(language) },
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

    const text = normalizeSignText(String(parsed.text ?? '').trim(), language);
    const kindRaw = String(parsed.kind ?? 'unknown').toLowerCase();
    const kind = ['word', 'phrase', 'letter', 'number', 'sentence', 'unknown'].includes(kindRaw) ? kindRaw : 'unknown';
    let confidence = clamp01(Number(parsed.confidence));
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
    const sanity = applySignSanityChecks({
        text: reconciled.text,
        kind: reconciled.kind,
        confidence,
        handedness,
        motion,
        nonManual,
        reasoning,
        alternatives,
    }, language);

    return {
        text: sanity.text,
        kind: sanity.kind,
        kindRaw: kind,
        confidence: sanity.confidence,
        alternatives,
        handedness,
        motion,
        nonManual,
        reasoning,
        model,
        language,
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
    // interrogación/exclamación, o un verbo conjugado típico en español/inglés.
    const hasSentencePunct = /[.!?¡¿]/.test(text);
    const verbHint = /\b(es|son|soy|eres|está|estoy|estás|estamos|están|hay|tengo|tienes|tiene|tenemos|tienen|quiero|quieres|quiere|necesito|necesitas|necesita|voy|vas|va|vamos|van|hago|haces|hace|hacemos|hacen|puedo|puedes|puede|amo|amas|ama|sé|sabes|sabe|gusta|gustan|llamo|llamas|llama|vivo|vives|vive|am|are|is|was|were|be|been|being|have|has|had|do|does|did|can|will|would|want|need|needs|like|likes|love|loves|go|goes|going|went|eat|eats|drink|drinks|work|works|study|studies|learn|learns|understand|understands|help|helps|live|lives|feel|feels|know|knows|see|sees|come|comes|meet|meets|name|names)\b/i;

    // 3) Oración: 5+ palabras, o puntuación de cierre, o verbo conjugado
    // en una unidad de 2+ palabras. Una sola glosa como "Help" sigue siendo word.
    if (wordCount >= 5 || hasSentencePunct || (wordCount >= 2 && verbHint.test(text))) {
        return { text, kind: 'sentence' };
    }

    // 4) Palabra única (sin espacios reales).
    if (wordCount <= 1) {
        return { text, kind: 'word' };
    }

    // 5) Resto (2-4 palabras, sin verbo, sin puntuación final): phrase.
    return { text, kind: 'phrase' };
}

function normalizeLscText(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return '';
    const key = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[¿?¡!.,;:()]/g, ' ')
        .replace(/[_/]+/g, ' ')
        .replace(/\s*-\s*/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('es');
    const spacedKey = key.replace(/-/g, ' ');
    if ((key.includes('buenas-tardes') || spacedKey.includes('buenas tardes')) &&
        (key.includes('como-esta') || spacedKey.includes('como esta'))) {
        return 'Buenas tardes, ¿cómo estás?';
    }
    if (key.includes('agradecer') || key.includes('gracias') || spacedKey.includes('decir gracias')) {
        return 'Gracias';
    }
    if (key.includes('decir-hola') || spacedKey.includes('decir hola')) {
        return 'Hola';
    }
    if (key.includes('como-estar') || spacedKey.includes('como estar') || spacedKey.includes('como estas')) {
        return '¿Cómo estás?';
    }
    if (key.includes('buenas-tardes') || spacedKey.includes('buenas tardes')) {
        return 'Buenas tardes';
    }
    if (key.includes('buenos-dias') || spacedKey.includes('buenos dias')) {
        return 'Buenos días';
    }
    if (key.includes('buenas-noches') || spacedKey.includes('buenas noches')) {
        return 'Buenas noches';
    }
    if (key.includes('decir-adios') || spacedKey.includes('decir adios')) {
        return 'Adiós';
    }
    return LSC_TEXT_NORMALIZATIONS.get(key) ||
        LSC_TEXT_NORMALIZATIONS.get(spacedKey) ||
        normalizeSpanishDisplay(text);
}

function normalizeSpanishDisplay(text) {
    const trimmed = String(text || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) return '';
    const lower = trimmed.toLocaleLowerCase('es');
    if (/^como est[aá]s\??$/i.test(trimmed) || /^cómo est[aá]s\??$/i.test(trimmed)) {
        return '¿Cómo estás?';
    }
    if (/^buenos dias$/i.test(lower)) return 'Buenos días';
    if (/^buenas tardes$/i.test(lower)) return 'Buenas tardes';
    if (/^buenas noches$/i.test(lower)) return 'Buenas noches';
    if (/^estoy bien$/i.test(lower) || /^yo estoy bien$/i.test(lower)) return 'Estoy bien';
    if (/^te amo$/i.test(lower)) return 'Te amo';
    if (/^gracias$/i.test(lower)) return 'Gracias';
    if (/^hola$/i.test(lower)) return 'Hola';
    return trimmed.charAt(0).toLocaleUpperCase('es') + trimmed.slice(1);
}

function normalizeSignText(rawText, language) {
    return resolveSignLanguageProfile(language) === 'lsc'
        ? normalizeLscText(rawText)
        : normalizeAslText(rawText);
}

function normalizeAslText(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return '';
    const key = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[¿?¡!.,;:()]/g, ' ')
        .replace(/[_/]+/g, ' ')
        .replace(/\s*-\s*/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('en-US');
    const spacedKey = key.replace(/-/g, ' ');

    const letterMatch = spacedKey.match(/^(?:letter|alphabet|fingerspell|fingerspelling)\s+([a-z])$/i);
    if (letterMatch) return letterMatch[1].toLocaleUpperCase('en-US');

    const numberWords = new Map([
        ['zero', '0'],
        ['one', '1'],
        ['two', '2'],
        ['three', '3'],
        ['four', '4'],
        ['five', '5'],
        ['six', '6'],
        ['seven', '7'],
        ['eight', '8'],
        ['nine', '9'],
        ['ten', '10'],
    ]);
    if (numberWords.has(spacedKey)) return numberWords.get(spacedKey);
    if (/^\d+$/.test(spacedKey)) return spacedKey;

    return ASL_TEXT_NORMALIZATIONS.get(key) ||
        ASL_TEXT_NORMALIZATIONS.get(spacedKey) ||
        normalizeEnglishDisplay(text);
}

function normalizeEnglishDisplay(text) {
    const trimmed = String(text || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) return '';
    const lower = trimmed.toLocaleLowerCase('en-US');
    if (/^how are you\??$/i.test(trimmed) || /^how you\??$/i.test(trimmed)) return 'How are you?';
    if (/^(what|where|who|when|why|how)\??$/i.test(trimmed)) {
        return `${trimmed.replace(/[?!.]+$/g, '').toLocaleLowerCase('en-US').replace(/^./, (c) => c.toLocaleUpperCase('en-US'))}?`;
    }
    if (/^i am fine\.?$/i.test(trimmed) || /^i'?m fine\.?$/i.test(trimmed)) return 'I am fine.';
    if (/^i love you\.?$/i.test(trimmed)) return 'I love you.';
    if (/^i do not understand\.?$/i.test(trimmed) || /^i don'?t understand\.?$/i.test(trimmed)) return "I don't understand.";
    if (/^nice to meet you\.?$/i.test(trimmed)) return 'Nice to meet you.';
    if (/^thank you\.?$/i.test(trimmed) || /^thanks\.?$/i.test(trimmed)) return 'Thank you';
    if (/^good morning\.?$/i.test(trimmed)) return 'Good morning';
    if (/^good afternoon\.?$/i.test(trimmed)) return 'Good afternoon';
    if (/^good night\.?$/i.test(trimmed)) return 'Good night';
    if (/^good ?bye\.?$/i.test(trimmed) || /^bye\.?$/i.test(trimmed)) return 'Goodbye';
    if (/^ok(?:ay)?\.?$/i.test(trimmed)) return 'Okay';
    if (/^[a-z]$/i.test(trimmed)) return trimmed.toLocaleUpperCase('en-US');
    return trimmed.charAt(0).toLocaleUpperCase('en-US') + trimmed.slice(1);
}

function applySignSanityChecks(rec, language) {
    return resolveSignLanguageProfile(language) === 'lsc'
        ? applyLscSanityChecks(rec)
        : applyAslSanityChecks(rec);
}

function applyAslSanityChecks(rec) {
    let { text, kind, confidence } = rec;
    const normalized = normalizeAslText(text);
    if (normalized) text = normalized;

    const haystack = [
        text,
        rec.reasoning,
        rec.motion?.trajectory,
        rec.nonManual?.facial,
        ...(rec.alternatives || []),
    ].filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    const hasFaceContact = rec.motion?.contact === 'hand-face' || /\b(chin|mouth|lip|lips|face|forehead)\b/.test(haystack);
    const hasChestContact = rec.motion?.contact === 'hand-body' || /\b(chest|torso|body)\b/.test(haystack);
    const hasQuestionCue = rec.nonManual?.intent === 'question' || /(\?|question|eyebrow|eyebrows|raised brow|wh\b)/.test(haystack);
    const hasLoveCue = /\b(love|ily|i-l-y|heart|affection|pinkie|pinky|thumb.*index|index.*thumb)\b/.test(haystack);
    const hasFineCue = /\b(fine|good|positive|thumbs? up|state|well)\b/.test(haystack);
    const hasThankCue = /\b(thank|gratitude|chin|mouth|lips|outward from face)\b/.test(haystack);
    const hasPleaseCue = /\b(please|open palm|flat hand|circle|circular|rub|rubbing)\b/.test(haystack) && hasChestContact;
    const hasSorryCue = /\b(sorry|apology|fist|s hand|circular)\b/.test(haystack) && hasChestContact;

    if (text === 'Thank you' && !hasFaceContact && hasFineCue) {
        text = 'I am fine.';
        kind = 'sentence';
        confidence = Math.min(confidence, 0.72);
    }

    if (text === 'Thank you' && !hasFaceContact && !hasThankCue && confidence < 0.78) {
        confidence = Math.min(confidence, 0.49);
    }

    if (text === 'How are you?' && !hasQuestionCue && confidence < 0.8) {
        confidence = Math.min(confidence, 0.52);
    }

    if (text === 'I love you.' && !hasLoveCue && hasQuestionCue) {
        text = 'How are you?';
        kind = 'sentence';
        confidence = Math.min(confidence, 0.7);
    } else if (text === 'I love you.' && !hasLoveCue && confidence < 0.82) {
        confidence = Math.min(confidence, 0.5);
    }

    if (text === 'Hello' && rec.handedness === 'both' && hasQuestionCue && confidence < 0.8) {
        text = 'How are you?';
        kind = 'sentence';
        confidence = Math.min(confidence, 0.68);
    }

    if (text === 'Please' && hasSorryCue && !hasPleaseCue && confidence < 0.78) {
        text = 'Sorry';
        kind = 'word';
        confidence = Math.min(confidence, 0.7);
    } else if (text === 'Sorry' && hasPleaseCue && !hasSorryCue && confidence < 0.78) {
        text = 'Please';
        kind = 'word';
        confidence = Math.min(confidence, 0.7);
    }

    const reconciled = reconcileKind(text, kind);
    return {
        text: reconciled.text,
        kind: reconciled.kind,
        confidence: clamp01(confidence),
    };
}

function applyLscSanityChecks(rec) {
    let { text, kind, confidence } = rec;
    const normalized = normalizeLscText(text);
    if (normalized) text = normalized;

    const haystack = [
        text,
        rec.reasoning,
        rec.motion?.trajectory,
        rec.nonManual?.facial,
        ...(rec.alternatives || []),
    ].filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    const hasFaceContact = rec.motion?.contact === 'hand-face' || /\b(menton|barbilla|boca|labio|labios|cara|rostro)\b/.test(haystack);
    const hasQuestionCue = rec.nonManual?.intent === 'question' || /(\?|ceja|cejas|pregunta|interrog)/.test(haystack);
    const hasLoveCue = /\b(amor|amo|ily|corazon|afecto|querer)\b/.test(haystack);
    const hasBienCue = /\b(bien|pecho|estado|positivo|ok|pulgar)\b/.test(haystack);

    if (text === 'Gracias' && !hasFaceContact && hasBienCue) {
        text = 'Estoy bien';
        kind = 'sentence';
        confidence = Math.min(confidence, 0.72);
    }

    if (text === 'Gracias' && !hasFaceContact && confidence < 0.75) {
        confidence = Math.min(confidence, 0.49);
    }

    if (text === '¿Cómo estás?' && !hasQuestionCue && confidence < 0.8) {
        confidence = Math.min(confidence, 0.52);
    }

    if (text === 'Te amo' && !hasLoveCue && hasQuestionCue) {
        text = '¿Cómo estás?';
        kind = 'sentence';
        confidence = Math.min(confidence, 0.7);
    } else if (text === 'Te amo' && !hasLoveCue && confidence < 0.82) {
        confidence = Math.min(confidence, 0.5);
    }

    if (text === 'Hola' && rec.handedness === 'both' && hasQuestionCue && confidence < 0.8) {
        text = '¿Cómo estás?';
        kind = 'sentence';
        confidence = Math.min(confidence, 0.68);
    }

    const reconciled = reconcileKind(text, kind);
    return {
        text: reconciled.text,
        kind: reconciled.kind,
        confidence: clamp01(confidence),
    };
}

function normalizeVocabulary(vocabulary = [], language) {
    const profile = resolveSignLanguageProfile(language);
    const source = Array.isArray(vocabulary) && vocabulary.length
        ? vocabulary
        : profile === 'lsc'
            ? LSC_BASIC_VOCABULARY
            : ASL_BASIC_VOCABULARY;
    const out = [];
    const seen = new Set();
    for (const item of source) {
        const normalized = normalizeSignText(String(item || '').trim(), profile);
        if (!normalized) continue;
        const key = normalizeTranscriptKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
    }
    return out.slice(0, 80);
}

function buildVocabularyInstruction(vocabulary, language) {
    if (!Array.isArray(vocabulary) || !vocabulary.length) return null;
    const profile = resolveSignLanguageProfile(language);
    const list = normalizeVocabulary(vocabulary, profile);
    if (!list.length) return null;
    if (profile === 'asl') {
        return [
            'DOMAIN VOCABULARY (visual hints, not a fixed answer list):',
            list.map((x) => `- ${x}`).join('\n'),
            'If the sign visually matches one of these entries, use exactly that English text.',
            'If it does not match, return unknown or an outside ASL sign only with clear visual evidence.',
        ].join('\n');
    }
    return [
        'VOCABULARIO DE DOMINIO (pistas, no respuesta fija):',
        list.map((x) => `- ${x}`).join('\n'),
        'Si la seña coincide visualmente con una entrada de esta lista, usa exactamente ese texto.',
        'Si no coincide, responde unknown o una seña externa solo con evidencia clara.',
    ].join('\n');
}

/**
 * Segmenta un stream de frames en unidades comunicativas antes de llamar al
 * VLM: movimiento sostenido produce clips dinamicos; quietud prolongada
 * produce candidatos estaticos para letras o numeros.
 */
export async function segmentSignFrames(frames, opts = {}) {
    if (!Array.isArray(frames) || frames.length === 0) {
        throw Object.assign(new Error('Se requiere al menos un frame.'), {
            code: 'EMPTY_STREAM', statusCode: 400,
        });
    }

    const timestampsMs = normalizeTimestamps(
        opts.timestampsMs,
        frames.length,
        Number(opts.frameIntervalMs) || STREAM_DEFAULT_FRAME_INTERVAL_MS,
    );
    const high = Number.isFinite(opts.motionHigh) ? opts.motionHigh : STREAM_MOTION_HIGH;
    const low = Number.isFinite(opts.motionLow) ? opts.motionLow : STREAM_MOTION_LOW;
    const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : STREAM_SETTLE_MS;
    const minMotionMs = Number.isFinite(opts.minMotionMs) ? opts.minMotionMs : STREAM_MIN_MOTION_MS;
    const minStaticMs = Number.isFinite(opts.minStaticMs) ? opts.minStaticMs : STREAM_MIN_STATIC_MS;
    const includeStatic = opts.includeStatic !== false;
    const motions = await computeStreamMotion(frames);
    const segments = [];

    let moving = false;
    let motionStart = 0;
    let lastMoving = 0;
    let motionPeak = 0;

    for (let i = 1; i < frames.length; i++) {
        const motion = motions[i] || 0;
        if (motion >= high) {
            if (!moving) {
                moving = true;
                motionStart = Math.max(0, i - 1);
                motionPeak = motion;
            } else {
                motionPeak = Math.max(motionPeak, motion);
            }
            lastMoving = i;
            continue;
        }

        if (!moving) continue;
        motionPeak = Math.max(motionPeak, motion);
        const quietMs = timestampsMs[i] - timestampsMs[lastMoving];
        if (motion <= low && quietMs >= settleMs) {
            maybePushMotionSegment(segments, {
                framesLength: frames.length,
                timestampsMs,
                start: motionStart,
                endInclusive: i,
                motionPeak,
                minMotionMs,
            });
            moving = false;
            motionPeak = 0;
        }
    }

    if (moving) {
        maybePushMotionSegment(segments, {
            framesLength: frames.length,
            timestampsMs,
            start: motionStart,
            endInclusive: frames.length - 1,
            motionPeak,
            minMotionMs,
        });
    }

    if (includeStatic) {
        addStaticHoldSegments(segments, {
            framesLength: frames.length,
            timestampsMs,
            motions,
            low,
            minStaticMs,
        });
    }

    return coalesceSegments(segments
        .sort((a, b) => a.start - b.start || a.end - b.end)
        .filter((seg, i, arr) => i === 0 || seg.start !== arr[i - 1].start || seg.end !== arr[i - 1].end));
}

/**
 * Reconoce una conversacion larga segmentando un stream de frames en clips
 * independientes y llamando al VLM por cada uno. Si se pasan segmentos
 * explicitos, los respeta; si no, usa segmentacion por movimiento/quietud.
 */
export async function recognizeSignStream(frames, opts = {}) {
    if (!Array.isArray(frames) || frames.length === 0) {
        throw Object.assign(new Error('Se requiere al menos un frame.'), {
            code: 'EMPTY_STREAM', statusCode: 400,
        });
    }
    if (opts.segmenter === 'timeline' || opts.analysisMode === 'timeline') {
        return recognizeSignTimeline(frames, opts);
    }
    const windowSize = clampInt(opts.windowSize, 2, MAX_FRAMES, 6);
    const stride = clampInt(opts.stride, 1, windowSize, Math.max(1, Math.floor(windowSize / 2)));
    const concurrency = clampInt(opts.concurrency, 1, 4, 1);
    const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.4;
    const timestampsMs = normalizeTimestamps(
        opts.timestampsMs,
        frames.length,
        Number(opts.frameIntervalMs) || STREAM_DEFAULT_FRAME_INTERVAL_MS,
    );

    const segments = Array.isArray(opts.segments) && opts.segments.length
        ? normalizeExplicitSegments(opts.segments, frames.length, timestampsMs)
        : opts.segmenter === 'sliding'
            ? slidingWindows(frames.length, windowSize, stride, timestampsMs)
            : await segmentSignFrames(frames, { ...opts, timestampsMs });

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
                    mode: segments[i].mode || (clip.length <= 1 ? 'static' : 'dynamic'),
                    model: opts.model,
                    timeoutMs: opts.timeoutMs,
                    vocabulary: opts.vocabulary,
                    language: opts.language,
                });
                results[i] = { ...segments[i], recognition: rec };
                if (rec && rec.text && rec.kind !== 'unknown' && rec.confidence >= minConfidence) {
                    previousText = `${previousText} ${rec.text}`.trim().slice(-300);
                }
            } catch (err) {
                results[i] = { ...segments[i], recognition: null, error: err?.message || String(err) };
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
        const key = normalizeTranscriptKey(t);
        if (!t || key === lastText) continue;
        transcriptParts.push(t);
        lastText = key;
    }

    return {
        segments: results,
        transcript: transcriptParts.join(' ').replace(/\s+([.,!?])/g, '$1').trim(),
    };
}

/**
 * Reconoce videos completos con ventanas temporales largas. Este modo evita
 * el error principal del pipeline por microclips: una misma seña dinámica se
 * partía en 2-4 clips y el VLM inventaba palabras distintas para cada trozo.
 */
export async function recognizeSignTimeline(frames, opts = {}) {
    if (!process.env.OPENROUTER_API_KEY) {
        throw Object.assign(new Error('OPENROUTER_API_KEY no está configurada.'), {
            code: 'VLM_NOT_CONFIGURED',
            statusCode: 503,
        });
    }
    if (!Array.isArray(frames) || frames.length === 0) {
        throw Object.assign(new Error('Se requiere al menos un frame.'), {
            code: 'EMPTY_STREAM', statusCode: 400,
        });
    }

    const timestampsMs = normalizeTimestamps(
        opts.timestampsMs,
        frames.length,
        Number(opts.frameIntervalMs) || STREAM_DEFAULT_FRAME_INTERVAL_MS,
    );
    const language = resolveSignLanguageProfile(opts.language);
    const vocabulary = normalizeVocabulary(opts.vocabulary, language);
    const windowMs = clampInt(opts.timelineWindowMs, 5_000, 120_000, TIMELINE_WINDOW_MS);
    const maxFramesPerWindow = clampInt(
        opts.timelineMaxFrames,
        4,
        24,
        TIMELINE_MAX_FRAMES_PER_WINDOW,
    );
    const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.55;
    const windows = buildTimelineWindows(frames.length, timestampsMs, windowMs);
    const segments = [];
    const events = [];
    let previousText = '';

    for (const window of windows) {
        const clipFrames = frames.slice(window.start, window.end);
        const clipTimes = timestampsMs.slice(window.start, window.end);
        if (!clipFrames.length) continue;
        try {
            const result = await recognizeTimelineWindow(clipFrames, clipTimes, {
                window,
                vocabulary,
                previousText,
                model: opts.model,
                timeoutMs: opts.timeoutMs,
                maxFramesPerWindow,
                strictVocabulary: opts.strictVocabulary !== false,
                language,
            });
            const accepted = result.events.filter((ev) => ev.confidence >= minConfidence);
            segments.push({ ...window, recognition: result });
            events.push(...accepted);
            if (accepted.length) {
                previousText = `${previousText} ${accepted.map((ev) => ev.text).join(' ')}`.trim().slice(-500);
            }
        } catch (err) {
            segments.push({ ...window, recognition: { events: [], notes: [] }, error: err?.message || String(err) });
        }
    }

    const collapsed = collapseTimelineEvents(events, {
        uniqueVocabulary: Boolean(opts.uniqueVocabulary),
        duplicateGapMs: Number.isFinite(opts.duplicateGapMs)
            ? Number(opts.duplicateGapMs)
            : TIMELINE_MIN_GAP_DUPLICATE_MS,
    });

    return {
        segments,
        events: collapsed,
        transcript: collapsed.map((ev) => ev.text).join(' ').replace(/\s+([.,!?])/g, '$1').trim(),
        vocabulary,
    };
}

async function recognizeTimelineWindow(frames, timestampsMs, opts) {
    const language = resolveSignLanguageProfile(opts.language);
    const sampled = sampleFrameTimePairs(frames, timestampsMs, opts.maxFramesPerWindow);
    const prompt = language === 'lsc'
        ? [
            'Modo de captura: TIMELINE DE VIDEO COMPLETO.',
            `Ventana analizada: ${formatSec(opts.window.startMs)}s a ${formatSec(opts.window.endMs)}s.`,
            'La ventana puede contener cero, una o varias señas completas.',
            'NO emitas un evento por frame. Fusiona la misma seña sostenida o repetida para enseñanza.',
            'Ignora postura neutra, brazos abajo, transiciones, pausas y silencio.',
            'Si aparece texto del material didáctico en pantalla, úsalo solo como pista débil cuando la seña manual coincide.',
            'Devuelve eventos en orden cronológico con tiempos absolutos del video.',
            'Si una seña no se ve completa dentro de la ventana, baja la confianza o no la emitas.',
            opts.previousText
                ? `Eventos aceptados antes de esta ventana: "${opts.previousText}". No los repitas salvo que la seña se haga de nuevo claramente.`
                : null,
            buildVocabularyInstruction(opts.vocabulary, language),
            opts.strictVocabulary
                ? 'En este modo de vocabulario, prioriza entradas del vocabulario. No inventes palabras fuera de la lista si el gesto es ambiguo.'
                : null,
            'Salida JSON estricta: {"events":[{"startSec":number,"endSec":number,"text":string,"kind":"word|phrase|letter|number|sentence","confidence":number,"evidence":string}],"notes":string[]}',
            'Máximo 6 eventos por ventana.',
        ].filter(Boolean).join('\n')
        : [
            'Capture mode: FULL VIDEO TIMELINE.',
            `Analyzed window: ${formatSec(opts.window.startMs)}s to ${formatSec(opts.window.endMs)}s.`,
            'This window may contain zero, one, or several complete ASL signs.',
            'Do not emit one event per frame. Merge the same sustained or repeated teaching sign.',
            'Ignore neutral posture, arms down, transitions, pauses, and silence.',
            'If instructional text appears on screen, use it only as a weak hint when the manual sign matches.',
            'Return events in chronological order with absolute video times.',
            'If a sign is incomplete inside this window, lower confidence or omit it.',
            opts.previousText
                ? `Accepted events before this window: "${opts.previousText}". Do not repeat them unless the sign is made again clearly.`
                : null,
            buildVocabularyInstruction(opts.vocabulary, language),
            opts.strictVocabulary
                ? 'In vocabulary mode, prioritize vocabulary entries. Do not invent outside words if the gesture is ambiguous.'
                : null,
            'Strict JSON output: {"events":[{"startSec":number,"endSec":number,"text":string,"kind":"word|phrase|letter|number|sentence","confidence":number,"evidence":string}],"notes":string[]}',
            'Maximum 6 events per window.',
        ].filter(Boolean).join('\n');

    const userParts = [{ type: 'text', text: prompt }];
    sampled.forEach((item, index) => {
        userParts.push({
            type: 'text',
            text: language === 'lsc'
                ? `Frame ${index + 1}/${sampled.length}: tiempo ${formatSec(item.atMs)}s`
                : `Frame ${index + 1}/${sampled.length}: time ${formatSec(item.atMs)}s`,
        });
        userParts.push({
            type: 'image_url',
            image_url: { url: toDataUrl(item.frame) },
        });
    });

    const timeoutMs = Number(opts.timeoutMs) || Math.max(REQUEST_TIMEOUT_MS, 45_000);
    const primaryModel = opts.model || DEFAULT_MODEL;
    const chain = [primaryModel, FALLBACK_MODEL, SECONDARY_FALLBACK_MODEL]
        .filter((m, i, arr) => m && arr.indexOf(m) === i);

    let lastErr = null;
    for (const model of chain) {
        try {
            const parsed = await callOpenRouterTimeline(model, userParts, timeoutMs, { language });
            return normalizeTimelineResult(parsed, opts);
        } catch (err) {
            lastErr = err;
            console.warn(`[SignLanguage][Timeline] ${model} falló (${err?.message || err}). Probando siguiente...`);
        }
    }
    throw lastErr || new Error('Todos los modelos timeline fallaron.');
}

async function callOpenRouterTimeline(model, userParts, timeoutMs, opts = {}) {
    const language = resolveSignLanguageProfile(opts.language);
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            model,
            messages: [
                { role: 'system', content: buildSystemPrompt(language) },
                { role: 'user', content: userParts },
            ],
            max_tokens: 1400,
            temperature: 0,
            top_p: 0.9,
            response_format: { type: 'json_object' },
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://tareamov.com',
                'X-Title': 'Tareamov Sign Language Timeline',
            },
            timeout: timeoutMs,
        },
    );

    const raw = response.data?.choices?.[0]?.message?.content || '';
    const parsed = safeParseJson(raw);
    if (!parsed) throw new Error(`Respuesta timeline no parseable: ${raw.slice(0, 120)}`);
    return parsed;
}

function normalizeTimelineResult(parsed, opts) {
    const rawEvents = Array.isArray(parsed?.events) ? parsed.events : [];
    const notes = Array.isArray(parsed?.notes)
        ? parsed.notes.filter((x) => typeof x === 'string').slice(0, 5)
        : [];
    const vocabularyByKey = new Map((opts.vocabulary || []).map((item) => [normalizeTranscriptKey(item), item]));
    const events = [];

    for (const raw of rawEvents) {
        const normalizedText = normalizeSignText(String(raw?.text || '').trim(), opts.language);
        if (!normalizedText) continue;
        const key = normalizeTranscriptKey(normalizedText);
        const vocabText = vocabularyByKey.get(key);
        if (opts.strictVocabulary && vocabularyByKey.size && !vocabText) continue;

        const text = vocabText || normalizedText;
        const reconciled = reconcileKind(text, raw?.kind || 'word');
        const startSec = normalizeTimelineSec(raw?.startSec, opts.window, opts.window.startMs / 1000);
        const endSec = normalizeTimelineSec(raw?.endSec, opts.window, startSec);
        events.push({
            startSec,
            endSec,
            startMs: Math.round(startSec * 1000),
            endMs: Math.round(endSec * 1000),
            text: reconciled.text,
            kind: reconciled.kind,
            confidence: clamp01(Number(raw?.confidence)),
            evidence: typeof raw?.evidence === 'string' ? raw.evidence.slice(0, 160) : '',
        });
    }

    events.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return { events, notes };
}

function buildTimelineWindows(total, timestampsMs, windowMs) {
    const out = [];
    if (!total) return out;
    const firstMs = timestampsMs[0] || 0;
    const lastMs = timestampsMs[total - 1] || firstMs;
    for (let startMs = firstMs; startMs <= lastMs; startMs += windowMs) {
        const endMs = Math.min(lastMs, startMs + windowMs);
        const start = findFirstAtOrAfter(timestampsMs, startMs);
        const end = Math.max(start + 1, findFirstAfter(timestampsMs, endMs));
        out.push({
            start,
            end: Math.min(total, end),
            startMs,
            endMs,
            mode: 'timeline',
        });
        if (endMs >= lastMs) break;
    }
    return out;
}

function sampleFrameTimePairs(frames, timestampsMs, maxFrames) {
    const pairs = frames.map((frame, i) => ({ frame, atMs: timestampsMs[i] || 0 }));
    if (pairs.length <= maxFrames) return pairs;
    const sampled = sampleEvenly(pairs, maxFrames);
    const seen = new Set();
    return sampled.filter((item) => {
        const key = item.atMs;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function collapseTimelineEvents(events, opts = {}) {
    const sorted = events
        .filter((ev) => ev && ev.text)
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const out = [];
    const seen = new Map();
    for (const ev of sorted) {
        const key = normalizeTranscriptKey(ev.text);
        if (opts.uniqueVocabulary && seen.has(key)) {
            const existing = seen.get(key);
            if (ev.confidence > existing.confidence) {
                Object.assign(existing, ev);
            }
            continue;
        }
        const last = out[out.length - 1];
        if (
            last &&
            normalizeTranscriptKey(last.text) === key &&
            ev.startMs - last.endMs <= opts.duplicateGapMs
        ) {
            last.endMs = Math.max(last.endMs, ev.endMs);
            last.endSec = Number((last.endMs / 1000).toFixed(1));
            last.confidence = Math.max(last.confidence, ev.confidence);
            continue;
        }
        const copy = {
            ...ev,
            startSec: Number((ev.startMs / 1000).toFixed(1)),
            endSec: Number((ev.endMs / 1000).toFixed(1)),
        };
        out.push(copy);
        seen.set(key, copy);
    }
    return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function normalizeTimelineSec(raw, window, fallback) {
    const n = Number(raw);
    const min = window.startMs / 1000;
    const max = window.endMs / 1000;
    if (!Number.isFinite(n)) return clampNumber(fallback, min, max);
    if (n >= min - 0.5 && n <= max + 0.5) return clampNumber(n, min, max);
    const relative = min + n;
    if (n >= 0 && relative <= max + 0.5) return clampNumber(relative, min, max);
    return clampNumber(fallback, min, max);
}

async function computeStreamMotion(frames) {
    const motions = new Array(frames.length).fill(0);
    let previous = null;
    for (let i = 0; i < frames.length; i++) {
        try {
            const current = await computeThumbnail(Buffer.isBuffer(frames[i]) ? frames[i] : bufferFromFrameString(frames[i]));
            motions[i] = previous ? motionScore(previous, current) : 0;
            previous = current;
        } catch (err) {
            console.warn('[SignLanguage][stream] motion falló:', err?.message || err);
            motions[i] = i === 0 ? 0 : 1;
            previous = null;
        }
    }
    return motions;
}

function normalizeTimestamps(raw, total, frameIntervalMs) {
    const fallback = Math.max(1, Number(frameIntervalMs) || STREAM_DEFAULT_FRAME_INTERVAL_MS);
    if (!Array.isArray(raw) || raw.length !== total) {
        return Array.from({ length: total }, (_v, i) => i * fallback);
    }
    const out = raw.map((v, i) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : i * fallback;
    });
    for (let i = 1; i < out.length; i++) {
        if (out[i] <= out[i - 1]) out[i] = out[i - 1] + fallback;
    }
    return out;
}

function maybePushMotionSegment(out, cfg) {
    const startMs = cfg.timestampsMs[cfg.start] || 0;
    const endMs = cfg.timestampsMs[cfg.endInclusive] || startMs;
    if (endMs - startMs < cfg.minMotionMs) return;

    const expanded = expandSegment({
        framesLength: cfg.framesLength,
        timestampsMs: cfg.timestampsMs,
        start: cfg.start,
        endInclusive: cfg.endInclusive,
        preRollMs: STREAM_PRE_ROLL_MS,
        postRollMs: STREAM_POST_ROLL_MS,
    });
    if (expanded.end - expanded.start < MIN_FRAMES) return;
    out.push({
        ...expanded,
        mode: expanded.end - expanded.start > STREAM_MAX_SEGMENT_FRAMES ? 'sentence' : 'dynamic',
        motionPeak: clamp01(cfg.motionPeak),
    });
}

function addStaticHoldSegments(out, cfg) {
    let stillStart = null;
    for (let i = 0; i <= cfg.framesLength; i++) {
        const isStill = i < cfg.framesLength && (cfg.motions[i] || 0) <= cfg.low;
        if (isStill) {
            if (stillStart == null) stillStart = i;
            continue;
        }
        if (stillStart == null) continue;

        const stillEnd = i - 1;
        const startMs = cfg.timestampsMs[stillStart] || 0;
        const endMs = cfg.timestampsMs[stillEnd] || startMs;
        if (endMs - startMs >= cfg.minStaticMs) {
            const center = Math.floor((stillStart + stillEnd) / 2);
            const candidate = {
                start: center,
                end: Math.min(cfg.framesLength, center + 1),
                startMs: cfg.timestampsMs[center] || 0,
                endMs: cfg.timestampsMs[center] || 0,
                mode: 'static',
                motionPeak: maxMotion(cfg.motions, stillStart, stillEnd),
            };
            if (!overlapsAny(candidate, out)) out.push(candidate);
        }
        stillStart = null;
    }
}

function expandSegment({ framesLength, timestampsMs, start, endInclusive, preRollMs, postRollMs }) {
    const fromMs = Math.max(0, (timestampsMs[start] || 0) - preRollMs);
    const toMs = (timestampsMs[endInclusive] || 0) + postRollMs;
    const expandedStart = findFirstAtOrAfter(timestampsMs, fromMs);
    const expandedEnd = Math.max(expandedStart + 1, findFirstAfter(timestampsMs, toMs));
    const end = Math.min(framesLength, expandedEnd);
    return {
        start: expandedStart,
        end,
        startMs: timestampsMs[expandedStart] || 0,
        endMs: timestampsMs[Math.max(expandedStart, end - 1)] || 0,
    };
}

function normalizeExplicitSegments(rawSegments, total, timestampsMs) {
    return rawSegments
        .map((s) => {
            const start = Math.max(0, Math.min(total, Math.floor(s.start ?? 0)));
            const end = Math.max(0, Math.min(total, Math.floor(s.end ?? start + 1)));
            const safeEnd = Math.max(start + MIN_FRAMES, end);
            const mode = ['static', 'dynamic', 'sentence'].includes(s.mode) ? s.mode : undefined;
            return {
                start,
                end: Math.min(total, safeEnd),
                startMs: Number.isFinite(Number(s.startMs)) ? Number(s.startMs) : (timestampsMs[start] || 0),
                endMs: Number.isFinite(Number(s.endMs)) ? Number(s.endMs) : (timestampsMs[Math.max(start, safeEnd - 1)] || 0),
                ...(mode ? { mode } : {}),
            };
        })
        .filter((s) => s.end - s.start >= MIN_FRAMES);
}

function overlapsAny(candidate, segments) {
    return segments.some((s) => candidate.start < s.end + 1 && candidate.end + 1 > s.start);
}

function coalesceSegments(segments) {
    const out = [];
    for (const seg of segments) {
        const last = out[out.length - 1];
        const bothDynamic = last &&
            last.mode !== 'static' &&
            seg.mode !== 'static';
        if (bothDynamic && seg.start < last.end) {
            last.end = Math.max(last.end, seg.end);
            last.endMs = Math.max(last.endMs || 0, seg.endMs || 0);
            last.motionPeak = Math.max(last.motionPeak || 0, seg.motionPeak || 0);
            last.mode = last.end - last.start > STREAM_MAX_SEGMENT_FRAMES ? 'sentence' : 'dynamic';
            continue;
        }
        out.push({ ...seg });
    }
    return out;
}

function findFirstAtOrAfter(values, target) {
    const idx = values.findIndex((v) => v >= target);
    return idx === -1 ? Math.max(0, values.length - 1) : idx;
}

function findFirstAfter(values, target) {
    const idx = values.findIndex((v) => v > target);
    return idx === -1 ? values.length : idx;
}

function maxMotion(motions, start, endInclusive) {
    let peak = 0;
    for (let i = start; i <= endInclusive; i++) peak = Math.max(peak, motions[i] || 0);
    return clamp01(peak);
}

function normalizeTranscriptKey(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLocaleLowerCase('es');
}

function bufferFromFrameString(frame) {
    if (typeof frame !== 'string') throw new Error('Frame invalido.');
    const clean = frame.includes(',') ? frame.split(',', 2)[1] : frame;
    return Buffer.from(clean, 'base64');
}

function slidingWindows(total, size, stride, timestampsMs = []) {
    const out = [];
    if (total <= size) {
        out.push({
            start: 0,
            end: total,
            startMs: timestampsMs[0] || 0,
            endMs: timestampsMs[Math.max(0, total - 1)] || 0,
            mode: total <= 1 ? 'static' : 'dynamic',
        });
        return out;
    }
    for (let start = 0; start + Math.min(size, MIN_FRAMES) <= total; start += stride) {
        const end = Math.min(total, start + size);
        out.push({
            start,
            end,
            startMs: timestampsMs[start] || 0,
            endMs: timestampsMs[Math.max(start, end - 1)] || 0,
            mode: end - start <= 1 ? 'static' : 'dynamic',
        });
        if (end === total) break;
    }
    return out;
}

function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumber(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function formatSec(ms) {
    const n = Number(ms) / 1000;
    if (!Number.isFinite(n)) return '0.0';
    return n.toFixed(1).replace(/\.0$/, '');
}

function buildModeInstruction(mode, language) {
    const profile = resolveSignLanguageProfile(language);
    if (profile === 'asl') {
        if (mode === 'static') {
            return [
                'Capture mode: STATIC. The server sent this frame because the hand stayed',
                'still for about 1 second. Prioritize kind="letter" or kind="number".',
                'Only return word/phrase/sentence if there is very clear visual evidence',
                'of a lexical static ASL sign.',
            ].join('\n');
        }
        if (mode === 'sentence') {
            return [
                'Capture mode: MOVING SENTENCE. The signer kept moving without a clear',
                'pause. Analyze the complete flow and transcribe the full ASL unit in',
                'English. If several signs are chained together, use kind="sentence"',
                'when the output is a complete sentence.',
            ].join('\n');
        }
        if (mode === 'dynamic') {
            return [
                'Capture mode: DYNAMIC. The server detected sustained movement followed',
                'by a pause. Recognize the complete ASL word, phrase, or sentence.',
                'Do not reduce it to one letter unless it is clearly fingerspelling.',
            ].join('\n');
        }
        return null;
    }

    if (mode === 'static') {
        return [
            'Modo de captura: ESTÁTICO. El servidor envió este frame porque la mano',
            'permaneció quieta cerca de 1 segundo. Prioriza kind="letter" o',
            'kind="number"; solo devuelve word/phrase/sentence si hay evidencia visual',
            'muy clara de una seña léxica estática de LSC.',
        ].join('\n');
    }
    if (mode === 'sentence') {
        return [
            'Modo de captura: ORACIÓN EN MOVIMIENTO. El usuario siguió moviendo las',
            'manos sin pausa clara; analiza el flujo completo y transcribe la unidad',
            'comunicativa completa en LSC. Si contiene varias señas encadenadas, usa',
            'kind="sentence" cuando corresponda.',
        ].join('\n');
    }
    if (mode === 'dynamic') {
        return [
            'Modo de captura: DINÁMICO. El servidor detectó movimiento sostenido y',
            'luego una pausa. Reconoce la palabra, frase u oración completa de LSC;',
            'no lo reduzcas a una sola letra salvo que sea claramente deletreo.',
        ].join('\n');
    }
    return null;
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

export default { recognizeSignClip, recognizeSignStream, recognizeSignTimeline, reconcileKind };
