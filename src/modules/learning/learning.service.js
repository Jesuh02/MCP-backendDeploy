/**
 * LearningDomainService — Generates AI-assisted learning artifacts (comics, video)
 * from the materials of a given course/topic/task.
 *
 * Pipeline:
 *   1. learningContextService.buildLearningContext() — pulls topic/task/RAG docs.
 *   2. LLM (text)  → produces a structured script (title + panels[]).
 *   3. LLM (image) → renders each panel via OpenRouter image-capable models.
 *   4. (video)     → produces a narrated script + poster image. Returns a job
 *                    stub when no video provider is configured so the client
 *                    can show a graceful "not yet available" state.
 *
 * Hex / SOLID:
 *   - Depends on ports (learningContextService, llmAdapter), not infra.
 *   - One responsibility: orchestrate the AI pipeline for learning artifacts.
 */
import axios from 'axios';
import { getCurrentTenantId, getPrimaryTenantId } from '../../config/tenantRegistry.js';

const DEFAULT_EVALUATION_TARGET_COUNT = 10;
const DEFAULT_PANEL_COUNT = DEFAULT_EVALUATION_TARGET_COUNT;
const MIN_COMIC_PANEL_COUNT = 10;
const MAX_COMIC_PANEL_COUNT = 16;
const DEFAULT_VIDEO_SCENE_COUNT = 10;
const MIN_VIDEO_SCENE_COUNT = 8;
const MAX_VIDEO_SCENE_COUNT = 12;
const DEFAULT_LEARNING_DIFFICULTY = 'HARD';
const LEARNING_ARTIFACT_VERSION = 1;
const DEFAULT_OPENROUTER_IMAGE_MODEL = 'openai/gpt-image-2';
const LEGACY_OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 90_000;

const ANALOGY_EXAMPLES = [
  {
    test: /(database|base de datos|sql|tabla|registro|consulta|query|relacion|indice|index)/i,
    text: 'databases as a labeled warehouse shelf with boxes, drawers, index cards, and people retrieving exact items',
  },
  {
    test: /(api|endpoint|http|request|response|fetch|rest|graphql|servicio|microservicio)/i,
    text: 'API consumption as a restaurant: customers place orders, a waiter carries requests, the kitchen prepares data, and plates return as responses',
  },
  {
    test: /(auth|login|autenticacion|autorizacion|token|jwt|password|permiso|rol)/i,
    text: 'authentication and permissions as a building entrance with badges, guards, keys, and restricted doors',
  },
  {
    test: /(algorithm|algoritmo|procedimiento|flujo|secuencia|condicional|loop|bucle|iteracion)/i,
    text: 'algorithms as a cooking recipe, assembly line, or checklist followed step by step',
  },
  {
    test: /(queue|cola|stack|pila|array|lista|estructura de datos|data structure)/i,
    text: 'data structures as real lines of people, stacked trays, sorted folders, or labeled containers',
  },
  {
    test: /(cloud|nube|servidor|deploy|hosting|infraestructura|contenedor|docker)/i,
    text: 'cloud infrastructure as a utility control room, shipping hub, or modular factory with connected stations',
  },
  {
    test: /(network|red|internet|socket|websocket|paquete|protocol|protocolo)/i,
    text: 'networks as roads, postal routes, traffic lights, mail carriers, and dispatch centers moving parcels',
  },
  {
    test: /(variable|funcion|function|metodo|clase|objeto|component|componente)/i,
    text: 'programming concepts as labeled containers, reusable workshop machines, tool benches, and modular building blocks',
  },
];

const TECHNICAL_VISUAL_EXAMPLES = [
  {
    test: /(codigo|code|programa|programacion|python|javascript|typescript|java|c\+\+|html|css|script|funcion|function|metodo|class|clase|variable|if|for|while|return|const|let|def|print|console\.log)/i,
    text: 'prepare a readable 3-5 line code snippet for the side explanation panel; the image itself must only show the real-life analogy without readable text',
  },
  {
    test: /(database|base de datos|sql|tabla|registro|consulta|query|join|select|insert|update|where|indice|index)/i,
    text: 'prepare a small SQL query, table rows, column names, keys, or index example for the side explanation panel; the image itself must stay text-free',
  },
  {
    test: /(api|endpoint|http|request|response|fetch|rest|graphql|json|servicio|microservicio)/i,
    text: 'prepare an endpoint, HTTP method, request/response JSON, or data contract for the side explanation panel; the image itself must not contain readable text',
  },
  {
    test: /(algoritmo|algorithm|diagrama|flujo|flowchart|secuencia|condicional|loop|bucle|iteracion)/i,
    text: 'prepare numbered steps, a condition branch, or loop explanation for the side panel; the image should show the process through action without labels',
  },
  {
    test: /(formula|ecuacion|equation|matematica|calculo|grafica|chart|dataset|datos|csv|estadistica|modelo|ml|machine learning)/i,
    text: 'prepare the formula, dataset sample, chart reading, notebook cell, or model explanation for the side panel; keep the image free of readable symbols and text',
  },
  {
    test: /(docker|contenedor|deploy|cloud|nube|servidor|arquitectura|architecture|red|network|socket|websocket)/i,
    text: 'prepare an architecture note, command, service boxes, ports, packets, or deployment detail for the side panel; the image should use unlabeled objects and actions',
  },
];

const DEFAULT_ANALOGY =
  'choose one concrete everyday place such as a restaurant, workshop, library, warehouse, classroom, post office, clinic, or kitchen, and make the lesson visible through physical objects and human actions';
const DEFAULT_TECHNICAL_VISUAL =
  'when the lesson has concrete artifacts, prepare one specific code snippet, formula, table, endpoint, diagram note, command, dataset, interface state, or domain object for the side explanation panel';

// In-process async job store for video generation.
// Single-instance deployments (Railway) are fine; for multi-instance add Redis.
const videoJobs = new Map(); // jobId -> { status, title, summary?, posterUrl, videoUrl?, slides?, sceneNotes?, durationSeconds, error?, createdAt }
const videoJobsByArtifactKey = new Map(); // artifact json key -> jobId
const comicArtifactsInFlight = new Map(); // artifact json key -> Promise<ComicResult>
const VIDEO_JOB_TTL_MS = 30 * 60 * 1000; // 30 min

const COMIC_SYSTEM_PROMPT = `Eres un guionista pedagógico que transforma material de estudio en una historieta (cómic) didáctica.
Devuelves SIEMPRE un único objeto JSON válido (sin Markdown, sin texto fuera del JSON) con la forma exacta:
{
  "title": "Título corto y atractivo",
  "panels": [
    {
      "caption": "Explicacion detallada de la situacion que ocurre en el panel y como representa el concepto tecnico. Debe conectar la alegoria visual con el contenido real del tema (max 300 caracteres). En espanol.",
      "dialogue": "Diálogo opcional entre personajes, breve (puede omitirse).",
      "technicalDetail": "OBLIGATORIO: Codigo real, formula, endpoint, query SQL, JSON, tabla, comando, diagrama ASCII o dato concreto del tema. Este contenido aparece en un panel lateral derecho, NUNCA dentro de la imagen. Debe ser codigo o contenido tecnico REAL y FUNCIONAL relacionado con el tema (max 500 caracteres).",
      "imagePrompt": "Visual description in ENGLISH: educational cartoon style, vibrant colors, real-life analogy scene. CRITICAL: NO text, NO code, NO letters, NO numbers, NO labels, NO speech bubbles, NO screens with text, NO signs, NO writing of any kind visible in the image. Only show physical objects, people, actions, and environments. 4:3 aspect ratio."
    }
  ]
}

REGLAS CRITICAS:
1. IMAGEN SIN TEXTO: La imagen generada NO debe contener NINGUN texto visible. Los modelos de IA escriben mal el texto en imagenes. Todo texto/codigo va en "technicalDetail".

2. TECHNICALDETAIL OBLIGATORIO: Si el tema trata de programacion, codigo, SQL, API, formulas, datos, arquitectura, comandos, variables, funciones, clases, algoritmos, estructuras de datos, redes, bases de datos, etc., el campo "technicalDetail" es OBLIGATORIO en CADA panel y debe contener:
   - Fragmentos de codigo REALES y FUNCIONALES
   - Queries SQL completas
   - Endpoints con metodo HTTP y ejemplo de request/response
   - JSON de ejemplo
   - Comandos de terminal
   - Formulas matematicas
   - Diagramas ASCII simples

3. ALEGORIA + CONTENIDO REAL: La historia debe ser una alegoria de la vida real (restaurante, biblioteca, fabrica, cocina, oficina de correos, etc.) PERO el "technicalDetail" debe traer el contenido tecnico REAL que esa alegoria representa.

4. CAPTION EXPLICATIVO: El "caption" debe explicar claramente:
   - Que situacion ocurre en la imagen
   - Como esa situacion de la vida real representa el concepto tecnico
   - La conexion entre la alegoria visual y el codigo/contenido en technicalDetail

5. IMAGEPROMPT SIN TEXTO: Describe solo objetos fisicos, personas, acciones, lugares. Ejemplos:
   - CORRECTO: "A chef in a busy kitchen receiving order tickets and preparing dishes"
   - INCORRECTO: "A chef with a sign that says 'API REQUEST'"

6. Genera minimo 10 paneles con principio, desarrollo, practica guiada y cierre. Si el plan evaluativo pide mas preguntas, genera al menos un panel por pregunta esperada.

7. CODIGO PROGRESIVO: El codigo en "technicalDetail" debe PROGRESAR con la historia:
   - Panel 1: Muestra el problema o concepto inicial (ej: definicion de variable, importacion)
   - Panel 2-3: Desarrollo del codigo paso a paso (ej: funciones, logica)
   - Panel 4+: Codigo completo o resultado final
   Cada panel debe mostrar una PARTE DIFERENTE del codigo que se relaciona con esa escena especifica.

8. EJEMPLOS DE TECHNICALDETAIL POR PANEL (si el tema es Python):
   Panel 1 (problema): "# El usuario quiere saludar\\nname = input('Tu nombre: ')"
   Panel 2 (solucion): "def greet(name):\\n    return f'Hola, {name}!'"
   Panel 3 (uso): "result = greet(name)\\nprint(result)"
   Panel 4 (completo): "# Programa completo\\ndef greet(name):\\n    return f'Hola, {name}!'\\n\\nname = input('Tu nombre: ')\\nprint(greet(name))"

9. Apoyate en los materiales proporcionados. Si son escasos, complementa con conocimiento general.`;

const COMIC_DIALOGUE_SYSTEM_PROMPT = `Eres un guionista pedagogico que transforma material de estudio en una historieta educativa con personajes hablando.
Devuelves SIEMPRE un unico objeto JSON valido (sin Markdown, sin texto fuera del JSON) con la forma exacta:
{
  "title": "Titulo corto y atractivo",
  "panels": [
    {
      "caption": "Explicacion detallada de la situacion que ocurre en el panel y como representa el concepto tecnico. Debe conectar la alegoria visual con el contenido real del tema (max 300 caracteres). En espanol.",
      "dialogue": "OBLIGATORIO: dialogo breve en espanol entre personajes, listo para aparecer como globo de texto dentro de la imagen (max 140 caracteres).",
      "technicalDetail": "OBLIGATORIO: Codigo real, formula, endpoint, query SQL, JSON, tabla, comando, diagrama ASCII o dato concreto del tema. Este contenido aparece en un panel lateral derecho, NUNCA dentro de la imagen. Debe ser codigo o contenido tecnico REAL y FUNCIONAL relacionado con el tema (max 500 caracteres).",
      "imagePrompt": "Visual description in ENGLISH: educational cartoon style, vibrant colors, real-life analogy scene with expressive characters talking. Include readable Spanish speech bubbles using the exact dialogue. CRITICAL: Only speech bubbles may contain text. NO code, NO formulas, NO labels, NO UI text, NO signs, NO watermarks. 4:3 aspect ratio."
    }
  ]
}

REGLAS CRITICAS:
1. IMAGEN CON DIALOGO: Cada imagen debe parecer un panel de comic real con personajes hablando. Usa globos de dialogo legibles en espanol con el texto de "dialogue".

2. DIALOGUE OBLIGATORIO: Cada panel debe tener 1 o 2 globos de dialogo cortos. El texto debe sonar natural, explicar una accion concreta y caber en la imagen.

3. TECHNICALDETAIL OBLIGATORIO: Si el tema trata de programacion, codigo, SQL, API, formulas, datos, arquitectura, comandos, variables, funciones, clases, algoritmos, estructuras de datos, redes, bases de datos, etc., el campo "technicalDetail" es OBLIGATORIO en CADA panel y debe contener:
   - Fragmentos de codigo REALES y FUNCIONALES
   - Queries SQL completas
   - Endpoints con metodo HTTP y ejemplo de request/response
   - JSON de ejemplo
   - Comandos de terminal
   - Formulas matematicas
   - Diagramas ASCII simples
   Este contenido tecnico NO va dentro de la imagen; va en el panel lateral de la UI.

4. ALEGORIA + CONTENIDO REAL: La historia debe ser una alegoria de la vida real (restaurante, biblioteca, fabrica, cocina, oficina de correos, etc.) PERO el "technicalDetail" debe traer el contenido tecnico REAL que esa alegoria representa.

5. CAPTION EXPLICATIVO: El "caption" debe explicar que ocurre en la imagen, como representa el concepto tecnico y como conecta con el codigo/contenido en technicalDetail.

6. IMAGEPROMPT CON GLOBOS DE DIALOGO: Describe objetos fisicos, personas, acciones, lugares y globos de dialogo. Solo los globos de dialogo pueden tener texto. No incluyas codigo, formulas, etiquetas, rotulos, marcas de agua ni pantallas con texto.

7. Genera minimo 10 paneles con principio, desarrollo, practica guiada y cierre. Si el plan evaluativo pide mas preguntas, genera al menos un panel por pregunta esperada.

8. PREPARACION PARA REFUERZO: Cada panel debe ensenar una habilidad que luego pueda evaluarse con multiple_choice, fill_in_blank u ordering. Incluye consecuencias, pasos ordenables y detalles tecnicos que el estudiante deba completar.

9. CODIGO PROGRESIVO: El codigo en "technicalDetail" debe PROGRESAR con la historia. Cada panel debe mostrar una PARTE DIFERENTE del codigo que se relaciona con esa escena especifica.

10. Apoyate en los materiales proporcionados. Si son escasos, complementa con conocimiento general.`;

const VIDEO_SYSTEM_PROMPT = `Eres un guionista pedagógico de video corto (60-90 s).
Devuelves SIEMPRE un único objeto JSON válido (sin Markdown), con la forma:
{
  "title": "Título atractivo",
  "summary": "Resumen del video en 1-2 frases",
  "scenes": [
    {
      "narration": "Explicacion detallada de la situacion que ocurre en la escena y como representa el concepto tecnico. Conecta la alegoria visual con el contenido real (max 300 caracteres).",
      "technicalDetail": "OBLIGATORIO: Codigo real, formula, endpoint, query SQL, JSON, tabla, comando o diagrama ASCII del tema. Aparece en panel lateral, NUNCA en la imagen/video (max 500 caracteres).",
      "imagePrompt": "Visual description in ENGLISH: educational cartoon style, vibrant colors, real-life analogy scene. CRITICAL: NO text, NO code, NO letters, NO numbers, NO labels, NO speech bubbles, NO screens with text. Only physical objects, people, actions. 4:3 aspect ratio."
    }
  ]
}

REGLAS CRITICAS:
1. VIDEO/IMAGEN SIN TEXTO: NO debe contener NINGUN texto visible. Los modelos de IA escriben mal el texto. Todo texto/codigo va en "technicalDetail".

2. TECHNICALDETAIL OBLIGATORIO: Si el tema trata de programacion, codigo, SQL, API, formulas, datos, arquitectura, etc., "technicalDetail" es OBLIGATORIO en CADA escena con:
   - Fragmentos de codigo REALES
   - Queries SQL completas
   - Endpoints con HTTP method y ejemplo
   - JSON de ejemplo
   - Comandos de terminal
   - Formulas o diagramas ASCII

3. ALEGORIA + CONTENIDO REAL: La historia es alegoria de vida real PERO "technicalDetail" trae el contenido tecnico REAL.

4. NARRATION EXPLICATIVO: Explica que ocurre en la escena y como representa el concepto tecnico.

5. IMAGEPROMPT SIN TEXTO: Solo objetos fisicos, personas, acciones, lugares.

6. Entre 8 y 12 escenas con principio, desarrollo, practica guiada y cierre. Debe cubrir las habilidades que se evaluaran en refuerzo.

7. PREPARACION PARA REFUERZO: Cada escena debe ensenar una habilidad que luego pueda evaluarse con multiple_choice, fill_in_blank u ordering. Incluye consecuencias, pasos ordenables y detalles tecnicos que el estudiante deba completar.

8. CODIGO PROGRESIVO: El codigo en "technicalDetail" debe PROGRESAR con la historia. Cada escena muestra una parte diferente del codigo que se relaciona con esa situacion especifica.`;

function safeParseJson(text) {
  if (!text) return null;
  // Strip ```json fences if present
  const stripped = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  // Try direct, then extract first {...}
  try { return JSON.parse(stripped); } catch (_) { /* try harder */ }
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* nope */ } }
  return null;
}

function buildSourceContext(ctx) {
  const lines = [];
  if (ctx?.topic?.name) lines.push(`Tema: ${ctx.topic.name}`);
  if (ctx?.topic?.description) lines.push(`Descripción del tema: ${ctx.topic.description}`);
  if (ctx?.task?.title) lines.push(`Tarea: ${ctx.task.title}`);
  if (ctx?.task?.description) lines.push(`Instrucciones de la tarea: ${ctx.task.description}`);
  if (ctx?.ragContent) {
    const trimmed = String(ctx.ragContent).slice(0, 12000);
    lines.push(`\nFragmentos de los documentos del tema/tarea:\n${trimmed}`);
  }
  if (!lines.length) lines.push('(Sin contenido extra disponible; usa conocimiento general apropiado al nivel.)');
  return lines.join('\n');
}

function learningSourceText(ctx) {
  return [
    ctx?.topic?.name,
    ctx?.topic?.description,
    ctx?.task?.title,
    ctx?.task?.description,
    ctx?.ragContent,
  ].filter(Boolean).join('\n');
}

function normalizeLearningDifficulty(value) {
  const difficulty = String(value || DEFAULT_LEARNING_DIFFICULTY).trim().toUpperCase();
  return ['EASY', 'INTERMEDIATE', 'HARD'].includes(difficulty) ? difficulty : DEFAULT_LEARNING_DIFFICULTY;
}

function normalizeLearningTargetCount(value, max = MAX_COMIC_PANEL_COUNT) {
  return boundedNumber(value, DEFAULT_EVALUATION_TARGET_COUNT, MIN_COMIC_PANEL_COUNT, max);
}

function inferLearningDomain(text) {
  const source = String(text || '').toLowerCase();
  if (/(jwt|oauth|ssl|tls|bearer|token|middleware|autentic|authentic|autoriz|authoriz|permiso|permission|rol|role|firma|signature|expir|session|sesion)/i.test(source)) {
    return 'API_SECURITY';
  }
  if (/(api|endpoint|http|request|response|rest|graphql|microservicio|servicio)/i.test(source)) {
    return 'API';
  }
  if (/(sql|select|insert|update|delete|join|tabla|database|base de datos|query|consulta)/i.test(source)) {
    return 'SQL';
  }
  if (/(algoritmo|algorithm|funcion|function|clase|class|variable|javascript|typescript|python|java|codigo|programacion)/i.test(source)) {
    return 'PROGRAMMING';
  }
  return 'GENERAL';
}

function buildEvaluationReadinessPlan(ctx, { difficulty, targetCount, mode = 'comic' } = {}) {
  const source = learningSourceText(ctx);
  const domain = inferLearningDomain(source);
  const normalizedDifficulty = normalizeLearningDifficulty(difficulty);
  const normalizedTargetCount = normalizeLearningTargetCount(targetCount);
  const lines = [
    'PLAN DE PREPARACION PARA REFUERZO:',
    `Despues de este ${mode}, el estudiante enfrentara cerca de ${normalizedTargetCount} preguntas de dificultad ${normalizedDifficulty}.`,
    'Ensenar antes de evaluar: concepto, criterio profesional, ejemplo tecnico, consecuencia de error y practica guiada.',
    'Cubrir los formatos del refuerzo: multiple_choice para consecuencias y decisiones, fill_in_blank para completar terminos/codigo/configuracion, ordering para ordenar flujos.',
    'Cada panel o escena debe preparar una pregunta probable, no solo decorar el tema.',
  ];

  if (domain === 'API_SECURITY') {
    lines.push(
      'Dominio detectado: seguridad en APIs.',
      'Cobertura obligatoria: SSL/TLS antes de procesar tokens, extraccion Bearer, verificacion criptografica de firma JWT, validacion de exp/nbf/iss/aud, identidad vs autorizacion por rol, minimo privilegio, respuestas 401 vs 403, flujo OAuth 2.0, sesion JWT stateless, logging sin secretos.',
      'Orden profesional esperado: transporte seguro -> autenticacion -> validacion de token -> carga de identidad -> autorizacion -> handler -> auditoria/respuesta.'
    );
  } else if (domain === 'API') {
    lines.push(
      'Dominio detectado: APIs.',
      'Cobertura obligatoria: contrato request/response, metodos HTTP, validacion de entrada, autenticacion/autorizacion cuando aplique, codigos de estado, errores, idempotencia y versionado.'
    );
  } else if (domain === 'SQL') {
    lines.push(
      'Dominio detectado: SQL/base de datos.',
      'Cobertura obligatoria: modelo de tablas, filtros, joins, claves, indices, integridad, consultas parametrizadas y consecuencias de consultas mal formuladas.'
    );
  } else if (domain === 'PROGRAMMING') {
    lines.push(
      'Dominio detectado: programacion.',
      'Cobertura obligatoria: entradas, transformacion, salida, control de flujo, casos borde, errores comunes, complejidad/orden de pasos cuando aplique y fragmentos de codigo funcionales.'
    );
  } else {
    lines.push(
      'Dominio detectado: general.',
      'Cobertura obligatoria: definiciones, relaciones causa-efecto, pasos operativos, errores comunes, criterios de decision y ejemplos aplicados.'
    );
  }

  return {
    domain,
    difficulty: normalizedDifficulty,
    targetCount: normalizedTargetCount,
    text: lines.join('\n'),
  };
}

function buildEvaluationPrepMeta(evaluationPlan) {
  const domain = evaluationPlan?.domain || 'GENERAL';
  const focusByDomain = {
    API_SECURITY: [
      'SSL/TLS antes de procesar tokens',
      'Firma JWT, expiracion y claims criticos',
      'Autenticacion vs autorizacion por rol',
      'Flujo OAuth 2.0 ordenado',
      'JWT stateless y revocacion',
      'Cadena de middleware con 401/403',
    ],
    API: [
      'Contrato request/response',
      'Metodos HTTP y codigos de estado',
      'Validacion de entrada',
      'Autenticacion y autorizacion',
      'Errores, idempotencia y versionado',
    ],
    SQL: [
      'Modelo de tablas y claves',
      'Filtros, joins e indices',
      'Integridad de datos',
      'Consultas parametrizadas',
      'Consecuencias de queries incorrectas',
    ],
    PROGRAMMING: [
      'Entradas, transformacion y salida',
      'Control de flujo',
      'Casos borde',
      'Errores comunes',
      'Orden de pasos y criterio tecnico',
    ],
    GENERAL: [
      'Definiciones esenciales',
      'Relaciones causa-efecto',
      'Pasos operativos',
      'Errores comunes',
      'Criterios de decision',
    ],
  };

  return {
    difficulty: evaluationPlan?.difficulty || DEFAULT_LEARNING_DIFFICULTY,
    targetCount: evaluationPlan?.targetCount || DEFAULT_EVALUATION_TARGET_COUNT,
    domain,
    questionTypes: [
      {
        type: 'fill_in_blank',
        label: 'Completar espacios',
        goal: 'Recordar con precision conceptos, claims, parametros, permisos o fragmentos tecnicos.',
      },
      {
        type: 'ordering',
        label: 'Ordenar flujos',
        goal: 'Reconstruir secuencias profesionales como middleware, OAuth, validacion o ejecucion paso a paso.',
      },
      {
        type: 'multiple_choice',
        label: 'Decisiones profesionales',
        goal: 'Elegir consecuencias, riesgos y criterios correctos ante casos reales.',
      },
    ],
    focusAreas: focusByDomain[domain] || focusByDomain.GENERAL,
  };
}

function hasEvaluationPrep(data) {
  return Boolean(
    data?.evaluationPrep &&
    Array.isArray(data.evaluationPrep.questionTypes) &&
    data.evaluationPrep.questionTypes.length >= 3 &&
    Array.isArray(data.evaluationPrep.focusAreas) &&
    data.evaluationPrep.focusAreas.length > 0
  );
}

function buildApiSecurityLearningItems() {
  return [
    {
      caption: 'La entrada segura empieza antes del token: primero se protege el canal para que las credenciales no viajen expuestas.',
      dialogue: 'Primero cerramos el tunel; despues revisamos la credencial.',
      technicalDetail: 'Orden inicial: HTTPS/TLS -> recibir request -> leer Authorization: Bearer <jwt>',
      imagePrompt: 'A guarded building entrance with a protected tunnel before a visitor reaches the badge desk.',
    },
    {
      caption: 'SSL/TLS evita que un atacante lea o altere el token mientras viaja entre cliente y API.',
      dialogue: 'Sin tunel seguro, el pase puede ser copiado en el camino.',
      technicalDetail: 'Rechazar en borde: if (req.protocol !== "https") return 400/redirect HTTPS;',
      imagePrompt: 'A courier carrying a sealed badge through a transparent secure tunnel while others cannot reach it.',
    },
    {
      caption: 'El middleware extrae el Bearer token y valida que la peticion tenga el formato correcto antes de confiar en sus datos.',
      dialogue: 'No basta traer un pase; debe venir en el formato correcto.',
      technicalDetail: 'const token = req.headers.authorization?.match(/^Bearer\\s+(.+)$/)?.[1];',
      imagePrompt: 'A receptionist checking that a visitor hands over the right kind of pass before entering.',
    },
    {
      caption: 'Verificar la firma JWT confirma que el token no fue modificado y que lo emitio una autoridad confiable.',
      dialogue: 'Si el sello no coincide, nadie entra.',
      technicalDetail: 'jwt.verify(token, publicKey, { algorithms: ["RS256"], issuer, audience });',
      imagePrompt: 'A security guard comparing a wax seal on a badge with an official seal stamp.',
    },
    {
      caption: 'Despues de la firma se validan expiracion, emisor, audiencia y ventanas de tiempo para no aceptar tokens viejos o fuera de contexto.',
      dialogue: 'Un pase vencido ya no abre la puerta.',
      technicalDetail: 'Claims criticos: exp, nbf, iat, iss, aud, sub. Token expirado => 401.',
      imagePrompt: 'A guard checking the date window on a visitor pass with an hourglass nearby.',
    },
    {
      caption: 'Autenticacion identifica quien es el usuario; autorizacion decide que puede hacer con ese rol o permiso.',
      dialogue: 'Ya se quien eres; ahora miro si puedes borrar.',
      technicalDetail: 'if (!user.roles.includes("admin")) return res.status(403).json({ error: "Forbidden" });',
      imagePrompt: 'A verified visitor standing before several doors while a guard points to the allowed door only.',
    },
    {
      caption: 'El minimo privilegio evita que un rol lector ejecute acciones destructivas aunque el token sea valido.',
      dialogue: 'Un lector puede consultar, no destruir registros.',
      technicalDetail: 'Permisos: reader: ["read"]; editor: ["read","write"]; admin: ["read","write","delete"]',
      imagePrompt: 'A library worker allowing reading at one desk but blocking access to a disposal machine.',
    },
    {
      caption: 'El flujo OAuth 2.0 separa consentimiento, codigo de autorizacion e intercambio por token para delegar acceso con alcance limitado.',
      dialogue: 'Primero permiso, luego codigo, despues token con alcance.',
      technicalDetail: 'OAuth order: authorize -> login/consent -> code -> token exchange -> scoped API request',
      imagePrompt: 'A visitor getting a permission slip, exchanging it at a counter, then accessing only one service window.',
    },
    {
      caption: 'Una sesion JWT stateless no requiere guardar sesion en memoria del servidor; cada peticion trae claims firmados verificables.',
      dialogue: 'La API revisa el pase en cada visita.',
      technicalDetail: 'Stateless: request + signed JWT claims -> verify each time. Revocation needs blacklist/short TTL.',
      imagePrompt: 'Several service counters independently checking the same signed badge without calling a central desk.',
    },
    {
      caption: 'La seguridad en APIs funciona como cadena de validaciones: si una etapa falla, no se debe continuar al handler protegido.',
      dialogue: 'Una sola validacion rota debilita toda la ruta.',
      technicalDetail: 'Secuencia: TLS -> JWT firma -> exp -> identidad -> rol/scope -> handler -> audit log',
      imagePrompt: 'A chain of checkpoint gates where each gate must open before a visitor reaches the final office.',
    },
    {
      caption: 'Los errores deben distinguir autenticacion fallida de autorizacion denegada sin filtrar secretos ni detalles internos.',
      dialogue: '401 si no eres valido; 403 si no tienes permiso.',
      technicalDetail: '401 Unauthorized: token ausente/invalido/expirado. 403 Forbidden: token valido sin permiso.',
      imagePrompt: 'A guard using two different exit lanes for invalid badges and valid badges without access.',
    },
    {
      caption: 'Antes de ejecutar la logica de negocio, el middleware deja trazabilidad segura para investigar intentos fallidos.',
      dialogue: 'Registramos el evento, nunca el secreto.',
      technicalDetail: 'log.warn({ userId, route, reason }, "auth_denied"); // no registrar token completo',
      imagePrompt: 'A security desk recording a safe incident note while keeping a sealed badge covered.',
    },
  ];
}

function buildGenericLearningItems(ctx) {
  const topic = ctx?.task?.title || ctx?.topic?.name || 'el tema';
  return [
    {
      caption: `Primero se define el problema central de ${topic} para que el estudiante sepa que debe reconocer en una pregunta dificil.`,
      dialogue: 'Antes de responder, nombremos el problema real.',
      technicalDetail: `Objetivo: identificar concepto, entrada, proceso, salida y criterio de exito en ${topic}.`,
      imagePrompt: 'A team around a workbench separating materials into problem, process, and result areas.',
    },
    {
      caption: 'Luego se separan conceptos parecidos para evitar confusiones en preguntas de seleccion multiple.',
      dialogue: 'Estas dos ideas se parecen, pero deciden cosas distintas.',
      technicalDetail: 'Practica multiple_choice: elegir la consecuencia correcta cuando cambia una condicion.',
      imagePrompt: 'A teacher comparing two similar tools on a table and showing when each one is used.',
    },
    {
      caption: 'El estudiante practica completar la pieza tecnica que falta, igual que en fill_in_blank.',
      dialogue: 'Si falta una pieza clave, el sistema no funciona.',
      technicalDetail: 'Practica fill_in_blank: completar el termino, parametro, paso, formula o fragmento de codigo correcto.',
      imagePrompt: 'A mechanic inserting the missing piece into a machine while others inspect the result.',
    },
    {
      caption: 'El orden de pasos se vuelve explicito para responder ejercicios de ordering sin memorizar frases sueltas.',
      dialogue: 'El orden importa tanto como la accion.',
      technicalDetail: 'Practica ordering: 1) preparar entrada 2) validar 3) transformar 4) comprobar salida 5) manejar errores.',
      imagePrompt: 'A production line with workers passing objects through ordered stations.',
    },
    {
      caption: 'Se muestran errores comunes y sus consecuencias para que el estudiante razone, no adivine.',
      dialogue: 'Este error parece pequeno, pero cambia el resultado.',
      technicalDetail: 'Criterio: explicar que falla, por que falla y como se corrige.',
      imagePrompt: 'A supervisor finding a small misplaced part that causes a whole process to stop.',
    },
    {
      caption: 'El cierre integra los pasos en una lista profesional de verificacion antes de intentar el refuerzo.',
      dialogue: 'Si puedes justificar cada paso, ya puedes practicar.',
      technicalDetail: 'Checklist: concepto -> ejemplo -> paso critico -> error comun -> decision correcta.',
      imagePrompt: 'A team finishing a clean checklist on a blank board with tools arranged neatly.',
    },
  ];
}

function buildFallbackLearningItems(ctx, evaluationPlan) {
  if (evaluationPlan?.domain === 'API_SECURITY') return buildApiSecurityLearningItems();
  return buildGenericLearningItems(ctx);
}

function normalizeGeneratedComicPanel(panel) {
  return {
    caption: String(panel?.caption || '').slice(0, 320),
    dialogue: normalizeComicDialogue(panel?.dialogue || ''),
    technicalDetail: getTechnicalDetail(panel),
    imagePrompt: String(panel?.imagePrompt || panel?.caption || '').slice(0, 900),
  };
}

function ensureComicPanelCount(panels, requiredCount, ctx, evaluationPlan) {
  const normalized = Array.isArray(panels) ? panels.map(normalizeGeneratedComicPanel) : [];
  const fallbackItems = buildFallbackLearningItems(ctx, evaluationPlan).map(normalizeGeneratedComicPanel);
  let index = 0;
  while (normalized.length < requiredCount && fallbackItems.length) {
    normalized.push({ ...fallbackItems[index % fallbackItems.length] });
    index++;
  }
  const desired = Math.max(requiredCount, Math.min(normalized.length, MAX_COMIC_PANEL_COUNT));
  return normalized.slice(0, desired);
}

function normalizeGeneratedVideoScene(scene) {
  return {
    narration: String(scene?.narration || scene?.caption || '').slice(0, 420),
    technicalDetail: getTechnicalDetail(scene),
    imagePrompt: String(scene?.imagePrompt || scene?.narration || scene?.caption || '').slice(0, 900),
  };
}

function ensureVideoSceneCount(scenes, requiredCount, ctx, evaluationPlan) {
  const normalized = Array.isArray(scenes) ? scenes.map(normalizeGeneratedVideoScene) : [];
  const fallbackItems = buildFallbackLearningItems(ctx, evaluationPlan).map((item) => normalizeGeneratedVideoScene({
    narration: item.caption,
    technicalDetail: item.technicalDetail,
    imagePrompt: item.imagePrompt,
  }));
  let index = 0;
  while (normalized.length < requiredCount && fallbackItems.length) {
    normalized.push({ ...fallbackItems[index % fallbackItems.length] });
    index++;
  }
  const desired = Math.max(requiredCount, Math.min(normalized.length, MAX_VIDEO_SCENE_COUNT));
  return normalized.slice(0, desired);
}

function pickAnalogyHints(text) {
  const source = String(text || '');
  const matches = ANALOGY_EXAMPLES
    .filter((item) => item.test.test(source))
    .map((item) => item.text);
  return matches.length ? matches.slice(0, 3) : [DEFAULT_ANALOGY];
}

function pickTechnicalVisualHints(text) {
  const source = String(text || '');
  const matches = TECHNICAL_VISUAL_EXAMPLES
    .filter((item) => item.test.test(source))
    .map((item) => item.text);
  return matches.length ? matches.slice(0, 3) : [DEFAULT_TECHNICAL_VISUAL];
}

function compactText(text, maxLen = 900) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function compactTechnicalDetail(text, maxLen = 500) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen);
}

function safePathSegment(value, fallback = '0') {
  const text = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback;
}

function normalizeIdForKey(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function extensionFromContentType(contentType, fallback = 'png') {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('quicktime')) return 'mov';
  if (ct.includes('json')) return 'json';
  return fallback;
}

function extensionFromUrl(url, fallback = 'png') {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) { /* ignore */ }
  return fallback;
}

function parseModelList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueModelList(models) {
  const seen = new Set();
  return models.filter((model) => {
    const key = String(model || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isImageModelFallbackError(err) {
  const status = err?.response?.status || err?.statusCode;
  const code = String(err?.code || err?.cause?.code || '');
  const message = String(err?.message || '');
  return status === 400 ||
    status === 404 ||
    status === 408 ||
    status === 422 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'ECONNABORTED' ||
    /timeout/i.test(message);
}

function imageContentType(value, fallback = 'image/png') {
  const text = String(value || '').trim().toLowerCase();
  return text.startsWith('image/') ? text : fallback;
}

function imageDataUrl(value, contentType = 'image/png') {
  const data = String(value || '').trim();
  if (!data) return '';
  if (/^data:image\//i.test(data)) return data;
  return `data:${imageContentType(contentType)};base64,${data}`;
}

function extractImageRefFromImagesApiResponse(payload) {
  const candidates = [];
  if (Array.isArray(payload?.data)) candidates.push(...payload.data);
  if (Array.isArray(payload?.images)) candidates.push(...payload.images);
  if (Array.isArray(payload?.output)) candidates.push(...payload.output);

  for (const item of candidates) {
    const contentType = imageContentType(
      item?.mime_type || item?.mimeType || item?.content_type || item?.contentType
    );
    if (item?.b64_json) return imageDataUrl(item.b64_json, contentType);
    if (item?.base64_json) return imageDataUrl(item.base64_json, contentType);
    if (item?.image_base64) return imageDataUrl(item.image_base64, contentType);
    if (item?.data && typeof item.data === 'string') return imageDataUrl(item.data, contentType);
    if (item?.url) return item.url;
    if (item?.image_url?.url) return item.image_url.url;
    if (item?.image?.b64_json) return imageDataUrl(item.image.b64_json, contentType);
    if (item?.image?.url) return item.image.url;
  }

  return '';
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function imageTimeoutForModel(model) {
  const configured = process.env.OPENROUTER_IMAGE_TIMEOUT_MS;
  if (configured) {
    return boundedNumber(configured, DEFAULT_OPENAI_IMAGE_TIMEOUT_MS, 30_000, 300_000);
  }
  return String(model || '').startsWith('openai/')
    ? DEFAULT_OPENAI_IMAGE_TIMEOUT_MS
    : DEFAULT_IMAGE_TIMEOUT_MS;
}

function comicPanelLimit(targetCount = DEFAULT_EVALUATION_TARGET_COUNT) {
  const desired = normalizeLearningTargetCount(targetCount, MAX_COMIC_PANEL_COUNT);
  return boundedNumber(process.env.OPENROUTER_COMIC_PANEL_LIMIT, desired, MIN_COMIC_PANEL_COUNT, MAX_COMIC_PANEL_COUNT);
}

function videoSceneLimit(targetCount = DEFAULT_EVALUATION_TARGET_COUNT) {
  const desired = normalizeLearningTargetCount(targetCount, MAX_VIDEO_SCENE_COUNT);
  return boundedNumber(process.env.OPENROUTER_VIDEO_SCENE_LIMIT, desired, MIN_VIDEO_SCENE_COUNT, MAX_VIDEO_SCENE_COUNT);
}

function parseDataUrl(dataUrl, fallbackExt = 'png') {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const raw = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(raw, 'base64')
    : Buffer.from(decodeURIComponent(raw), 'utf8');
  return {
    buffer,
    contentType,
    ext: extensionFromContentType(contentType, fallbackExt),
  };
}

function parseStoredArtifact(file) {
  const text = file?.content || (file?.buffer ? Buffer.from(file.buffer).toString('utf8') : '');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.data || parsed;
  } catch (_) {
    return null;
  }
}

function stripRuntimeArtifactFields(value) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  delete copy.cached;
  delete copy.artifactKey;
  delete copy.createdAt;
  return copy;
}

function storageMiss(err) {
  const status = err?.$metadata?.httpStatusCode || err?.statusCode || err?.response?.status;
  return status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey';
}

function hasMediaRef(value) {
  return Boolean(String(value || '').trim());
}

function hasUsableArtifactMedia(kind, data, requirements = {}) {
  if (requirements.requireEvaluationPrep && !hasEvaluationPrep(data)) return false;

  if (kind === 'comic') {
    const minPanels = Math.max(1, Number(requirements.minPanels) || 1);
    return Array.isArray(data?.panels) &&
      data.panels.length >= minPanels &&
      data.panels.every((panel) => hasMediaRef(panel?.imageUrl));
  }
  if (kind === 'video') {
    const minScenes = Math.max(1, Number(requirements.minScenes) || 1);
    const sceneDepth = Math.max(
      Array.isArray(data?.sceneNotes) ? data.sceneNotes.length : 0,
      Array.isArray(data?.slides) ? data.slides.length : 0
    );
    const hasRequiredDepth = sceneDepth >= minScenes;
    return (hasMediaRef(data?.videoUrl) && hasRequiredDepth) ||
      (Array.isArray(data?.slides) &&
        data.slides.length >= minScenes &&
        data.slides.every((slide) => hasMediaRef(slide?.imageUrl)));
  }
  return true;
}

function getTechnicalDetail(item) {
  return compactTechnicalDetail(
    item?.technicalDetail || item?.visualArtifact || item?.codeSnippet || item?.artifactText || '',
    500
  );
}

function sanitizeTextFreeVisualIdea(text) {
  return compactText(text, 900)
    .replace(/```[\s\S]*?```/g, ' blank prop ')
    .replace(/`[^`]+`/g, ' blank prop ')
    .replace(/\b(?:function|const|let|var|class|def|return|console\.log|print)\b[^.;]*/gi, 'blank prop')
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+/gi, 'blank prop')
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b[^.;]*/gi, 'blank prop')
    .replace(/\b(?:code|codigo|text|letters|label|formula|endpoint|json|sql|caption|subtitle|speech bubble)\b[^.;]*/gi, 'blank prop')
    .replace(/\b(screen|whiteboard|blackboard|sign|book|document|paper)\s+(?:with|showing|saying|displaying)\b[^.;]*/gi, '$1 as a blank unreadable prop')
    .replace(/[{}[\]<>_=+*/\\|~^`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTextFreeComicImageRequest(panel) {
  const visualIdea = sanitizeTextFreeVisualIdea(panel?.imagePrompt || panel?.caption || '').slice(0, 700);
  return [
    'TEXT-FREE COMIC PANEL ONLY.',
    visualIdea ? `Visual idea to reinterpret without text: ${visualIdea}.` : '',
    'Illustrate only the real-life analogy through people, objects, gestures, spaces, and cause-effect actions.',
    'If the idea mentions code, formulas, screens, books, documents, labels, signs, charts, tables, endpoints, numbers, or speech bubbles, show them only as blank unreadable props or abstract shapes with no glyphs.',
    'No written characters of any kind may appear in the image: no letters, no numbers, no code, no labels, no formulas, no subtitles, no UI text, no speech bubbles, no logos, no watermarks.',
  ].filter(Boolean).join('\n');
}

function sanitizeDialogueComicScene(text) {
  return compactText(text, 900)
    .replace(/```[\s\S]*?```/g, 'technical content kept outside the image')
    .replace(/`[^`]+`/g, 'technical content kept outside the image')
    .replace(/\b(?:function|const|let|var|class|def|return|console\.log|print)\b[^.;]*/gi, 'technical content kept outside the image')
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+/gi, 'technical endpoint kept outside the image')
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b[^.;]*/gi, 'technical query kept outside the image')
    .replace(/\b(?:code|codigo|formula|endpoint|json|sql)\b[^.;]*/gi, 'technical detail kept outside the image')
    .replace(/[{}[\]<>_=+*/\\|~^`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComicDialogue(text) {
  const cleaned = compactText(text, 180)
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 160);
}

function buildDialogueComicImageRequest(panel) {
  const visualIdea = sanitizeDialogueComicScene(panel?.imagePrompt || panel?.caption || '').slice(0, 760);
  const dialogue = normalizeComicDialogue(panel?.dialogue || '');
  return [
    'COMIC PANEL WITH READABLE SPANISH SPEECH BUBBLES.',
    dialogue ? `Characters must visibly speak in 1 or 2 speech bubbles. Exact speech bubble text: "${dialogue}".` : 'Add 1 short Spanish speech bubble where a character explains the action.',
    visualIdea ? `Scene to draw: ${visualIdea}.` : '',
    'Illustrate the real-life analogy through expressive characters, clear actions, physical objects, and a single focused environment.',
    'Use clean comic lettering with high contrast, large enough to read on mobile.',
    'Only the speech bubbles may contain readable text. Do not write code, formulas, endpoint paths, JSON, SQL, UI labels, signs, logos, subtitles, captions, or watermarks inside the image.',
    'Educational cartoon style, polished composition, vibrant but restrained colors, 4:3 aspect ratio.',
  ].filter(Boolean).join('\n');
}

function collectTechnicalHighlights(script) {
  const items = Array.isArray(script?.panels) ? script.panels : Array.isArray(script?.scenes) ? script.scenes : [];
  const seen = new Set();
  const highlights = [];
  for (const item of items) {
    const detail = getTechnicalDetail(item);
    if (!detail || seen.has(detail)) continue;
    seen.add(detail);
    highlights.push(detail);
    if (highlights.length >= 6) break;
  }
  return highlights;
}

function collectSceneNotes(script, limit = DEFAULT_VIDEO_SCENE_COUNT) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  return scenes.slice(0, limit).map((scene) => {
    const note = {
      narration: String(scene?.narration || '').slice(0, 420),
    };
    const technicalDetail = getTechnicalDetail(scene);
    if (technicalDetail) note.technicalDetail = technicalDetail;
    return note;
  }).filter((scene) => scene.narration || scene.technicalDetail);
}

function buildAnalogyVisualPrompt(prompt, { title = '', sourceContext = '', medium = 'image', allowSpeechText = false } = {}) {
  const isTextFree = /text-free/i.test(medium);
  const canRenderSpeechText = allowSpeechText || /speech|dialogue/i.test(medium);
  const subject = compactText([title, sourceContext, prompt].filter(Boolean).join(' '), 1400);
  const hints = pickAnalogyHints(subject).join('; ');
  const technicalHints = isTextFree || canRenderSpeechText ? '' : pickTechnicalVisualHints(subject).join('; ');
  const contextHint = compactText(sourceContext, 650);

  return [
    `Create a ${medium} for an educational lesson.`,
    title ? `Lesson title: ${title}.` : '',
    contextHint ? `Relevant context: ${contextHint}.` : '',
    `Core scene request: ${compactText(prompt, canRenderSpeechText ? 1100 : 700)}.`,
    `Use a concrete real-life analogy: ${hints}.`,
    technicalHints ? `External side-panel technical requirement: ${technicalHints}. The story must remain an analogy, and the actual code/data/formula/endpoint must be displayed by the UI outside the image.` : '',
    'Make the abstract idea visible through physical objects, people interacting, clear cause-and-effect, and a single focused environment.',
    canRenderSpeechText
      ? 'Readable text is allowed only inside the requested Spanish speech bubbles. Do not render code, formulas, table text, endpoint paths, JSON keys, commands, diagram labels, UI labels, signs, subtitles, captions, logos, or watermarks.'
      : 'Do not render any readable text inside the image or video: no code, letters, numbers, formulas, table text, endpoint paths, JSON keys, commands, diagram labels, captions, speech bubbles, logos, or watermarks.',
    isTextFree ? 'For this comic panel, every surface must be blank, pictorial, or abstract: blank screens, blank papers, blank signs, blank books, blank labels, and no glyph-like marks.' : '',
    'Avoid generic blank laptop screens, unrelated floating code, abstract icons, full UI screenshots, repeated headings, decorative labels, captions, logos, and watermarks.',
    'Style: polished educational illustration, warm realistic details, vibrant but restrained colors, cinematic composition, 4:3 aspect ratio unless video provider requires otherwise.',
  ].filter(Boolean).join('\n');
}

export class LearningDomainService {
  /**
   * @param {object} deps
   * @param {import('../ai/learning-context.service.js').LearningContextService} deps.learningContextService
   * @param {object} deps.llmAdapter — must expose chat(systemPrompt, userPrompt, options)
   */
  constructor({ learningContextService, llmAdapter, fileStoragePort = null }) {
    this.learningContextService = learningContextService;
    this.llmAdapter = llmAdapter;
    this.fileStoragePort = fileStoragePort;
    // Best-in-class OpenRouter models, overridable by env.
    // Video generation is fixed to Seedance 2.0 so this flow uses one provider model.
    this.imageModel = process.env.OPENROUTER_IMAGE_MODEL || DEFAULT_OPENROUTER_IMAGE_MODEL;
    this.comicImageModel = process.env.OPENROUTER_COMIC_IMAGE_MODEL || this.imageModel;
    this.imageFallbackModels = uniqueModelList([
      ...parseModelList(process.env.OPENROUTER_IMAGE_FALLBACK_MODELS),
      this.imageModel,
      LEGACY_OPENROUTER_IMAGE_MODEL,
    ]);
    this.textModel = process.env.OPENROUTER_LEARNING_MODEL || process.env.OPENROUTER_CHAT_MODEL || 'qwen/qwen-2.5-72b-instruct';
    this.videoModel = 'bytedance/seedance-2.0';
  }

  _storageAvailable() {
    if (!this.fileStoragePort) return false;
    if (typeof this.fileStoragePort.isAvailable === 'function') {
      return this.fileStoragePort.isAvailable();
    }
    return true;
  }

  _artifactDescriptor(kind, { courseId, topicId, taskId }) {
    const tenantId = safePathSegment(getCurrentTenantId() || getPrimaryTenantId() || 'default', 'default');
    const course = normalizeIdForKey(courseId);
    const topic = normalizeIdForKey(topicId);
    const task = normalizeIdForKey(taskId);
    const base = `learning/artifacts/${tenantId}/course_${course}/topic_${topic}/task_${task}`;
    return {
      kind,
      tenantId,
      courseId: course,
      topicId: topic,
      taskId: task,
      cacheKey: `${base}/${kind}.json`,
      mediaPrefix: `${base}/${kind}`,
    };
  }

  async _readStoredArtifact(kind, descriptor, requirements = {}) {
    if (!descriptor) return null;
    if (!this._storageAvailable() || typeof this.fileStoragePort.fetchFile !== 'function') return null;
    try {
      const file = await this.fileStoragePort.fetchFile(descriptor.cacheKey);
      const data = parseStoredArtifact(file);
      if (!data) return null;
      if (!hasUsableArtifactMedia(kind, data, requirements)) {
        console.warn(`[LearningService] Stored ${kind} artifact is too short or has no media; regenerating (${descriptor.cacheKey})`);
        return null;
      }
      const normalized = kind === 'video' ? { status: 'completed', ...data } : data;
      return { ...normalized, cached: true };
    } catch (err) {
      if (!storageMiss(err)) {
        console.warn(`[LearningService] Stored ${kind} lookup failed (${descriptor.cacheKey}): ${err?.message || err}`);
      }
      return null;
    }
  }

  async _writeStoredArtifact(kind, descriptor, data) {
    if (!descriptor) return false;
    if (!this._storageAvailable() || typeof this.fileStoragePort.uploadFile !== 'function') return false;
    const payload = {
      version: LEARNING_ARTIFACT_VERSION,
      kind,
      tenantId: descriptor.tenantId,
      courseId: descriptor.courseId,
      topicId: descriptor.topicId,
      taskId: descriptor.taskId,
      generatedAt: new Date().toISOString(),
      data: stripRuntimeArtifactFields(data),
    };
    const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
    await this.fileStoragePort.uploadFile(buffer, descriptor.cacheKey, 'application/json', buffer.length);
    return true;
  }

  async _persistMediaSource(sourceUrl, objectKeyBase, fallbackExt = 'png') {
    if (!sourceUrl || !this._storageAvailable() || typeof this.fileStoragePort.uploadFile !== 'function') {
      return sourceUrl || '';
    }
    if (typeof this.fileStoragePort.isR2Url === 'function' && this.fileStoragePort.isR2Url(sourceUrl)) {
      return sourceUrl;
    }
    if (this.fileStoragePort.publicUrl && String(sourceUrl).startsWith(String(this.fileStoragePort.publicUrl))) {
      return sourceUrl;
    }

    try {
      let buffer;
      let contentType;
      let ext;
      const dataUrl = parseDataUrl(sourceUrl, fallbackExt);
      if (dataUrl) {
        ({ buffer, contentType, ext } = dataUrl);
      } else if (/^https?:\/\//i.test(String(sourceUrl))) {
        const resp = await axios.get(sourceUrl, {
          responseType: 'arraybuffer',
          timeout: 120_000,
          headers: { 'User-Agent': 'CourseV-Server/1.0', Accept: '*/*' },
        });
        buffer = Buffer.from(resp.data);
        contentType = resp.headers['content-type'] || 'application/octet-stream';
        ext = extensionFromContentType(contentType, extensionFromUrl(sourceUrl, fallbackExt));
      } else {
        return sourceUrl;
      }

      const safeExt = safePathSegment(ext || fallbackExt, fallbackExt).replace(/^\.+/, '') || fallbackExt;
      const key = `${objectKeyBase}.${safeExt}`;
      return await this.fileStoragePort.uploadFile(buffer, key, contentType, buffer.length);
    } catch (err) {
      console.warn(`[LearningService] R2 media upload failed (${objectKeyBase}): ${err?.message || err}`);
      return sourceUrl;
    }
  }

  async _persistComicMedia(result, descriptor) {
    if (!descriptor) return result;
    if (!result?.panels?.length) return result;
    const panels = await Promise.all(result.panels.map(async(panel, index) => ({
      ...panel,
      imageUrl: await this._persistMediaSource(
        panel.imageUrl,
        `${descriptor.mediaPrefix}/panel_${String(index + 1).padStart(2, '0')}`,
        'png'
      ),
    })));
    return { ...result, panels };
  }

  async _persistVideoMedia(result, descriptor) {
    if (!descriptor) return result;
    const next = { ...result };
    if (next.posterUrl) {
      next.posterUrl = await this._persistMediaSource(next.posterUrl, `${descriptor.mediaPrefix}/poster`, 'png');
    }
    if (next.videoUrl) {
      next.videoUrl = await this._persistMediaSource(next.videoUrl, `${descriptor.mediaPrefix}/video`, 'mp4');
    }
    if (Array.isArray(next.slides)) {
      next.slides = await Promise.all(next.slides.map(async(slide, index) => ({
        ...slide,
        imageUrl: await this._persistMediaSource(
          slide.imageUrl,
          `${descriptor.mediaPrefix}/slide_${String(index + 1).padStart(2, '0')}`,
          'png'
        ),
      })));
    }
    return next;
  }

  // ───────────────────────── COMIC ─────────────────────────
  async generateComic({ courseId, topicId, taskId, userId, difficulty = DEFAULT_LEARNING_DIFFICULTY, targetCount = DEFAULT_EVALUATION_TARGET_COUNT }) {
    const normalizedDifficulty = normalizeLearningDifficulty(difficulty);
    const normalizedTargetCount = normalizeLearningTargetCount(targetCount);
    const panelCount = comicPanelLimit(normalizedTargetCount);
    const requirements = { minPanels: panelCount, requireEvaluationPrep: true };
    const descriptor = this._artifactDescriptor('comic', { courseId, topicId, taskId });
    const stored = await this._readStoredArtifact('comic', descriptor, requirements);
    if (stored) return stored;

    const flightKey = `${descriptor.cacheKey}:panels_${panelCount}`;
    const inFlight = comicArtifactsInFlight.get(flightKey);
    if (inFlight) return inFlight;

    const promise = this._generateComicFresh({
      courseId,
      topicId,
      taskId,
      userId,
      difficulty: normalizedDifficulty,
      targetCount: normalizedTargetCount,
      panelCount,
    })
      .then(async(result) => {
        const persisted = await this._persistComicMedia(result, descriptor);
        if (!hasUsableArtifactMedia('comic', persisted, requirements)) {
          throw new Error('No se pudieron renderizar imagenes para el comic. Revisa el modelo de imagen de OpenRouter.');
        }
        await this._writeStoredArtifact('comic', descriptor, persisted);
        return persisted;
      })
      .finally(() => comicArtifactsInFlight.delete(flightKey));

    comicArtifactsInFlight.set(flightKey, promise);
    return promise;
  }

  async _generateComicFresh({ courseId, topicId, taskId, userId, difficulty = DEFAULT_LEARNING_DIFFICULTY, targetCount = DEFAULT_EVALUATION_TARGET_COUNT, panelCount = null }) {
    const ctxResult = await this.learningContextService.buildLearningContext({ courseId, topicId, taskId, userId, query: null, retrievalMode: 'hybrid' });
    if (ctxResult.isFail && ctxResult.isFail()) {
      throw ctxResult.getError();
    }
    const ctx = ctxResult.getValue ? ctxResult.getValue() : ctxResult;
    const sourceContext = buildSourceContext(ctx);
    const evaluationPlan = buildEvaluationReadinessPlan(ctx, { difficulty, targetCount, mode: 'comic' });
    const desiredPanels = panelCount || comicPanelLimit(evaluationPlan.targetCount);

    const userPrompt =
      `Construye una historieta educativa basada EXCLUSIVAMENTE en este material:\n\n` +
      `${sourceContext}\n\n` +
      `${evaluationPlan.text}\n\n` +
      `Genera al menos ${desiredPanels} paneles. Cada panel debe preparar una pregunta dificil del modulo de refuerzo.`;

    const llmResp = await this.llmAdapter.chat(
      COMIC_DIALOGUE_SYSTEM_PROMPT,
      userPrompt,
      { model: this.textModel, temperature: 0.35, maxTokens: 8192 }
    );
    const script = safeParseJson(llmResp?.content);
    if (!script || !Array.isArray(script.panels) || !script.panels.length) {
      throw new Error('No fue posible interpretar la respuesta del modelo de texto.');
    }

    const title = String(script.title || ctx?.topic?.name || 'Cómic educativo');

    // Generate images in parallel (small fanout to respect rate limits)
    const panels = ensureComicPanelCount(script.panels, desiredPanels, ctx, evaluationPlan);
    const renderedPanels = await Promise.all(
      panels.map(async (p) => {
        const technicalDetail = getTechnicalDetail(p);
        const dialogue = normalizeComicDialogue(p.dialogue || '');
        const panelPrompt = buildDialogueComicImageRequest({ ...p, dialogue });
        const imageUrl = await this._renderImageSafely(
          String(panelPrompt || title),
          {
            title,
            sourceContext,
            medium: 'comic panel illustration with Spanish speech bubbles',
            allowSpeechText: true,
            model: this.comicImageModel,
          }
        );
        return {
          caption: String(p.caption || '').slice(0, 320),
          dialogue: dialogue || undefined,
          technicalDetail: technicalDetail || undefined,
          imageUrl,
        };
      })
    );

    return {
      jobId: `comic_${Date.now()}`,
      title,
      evaluationPrep: buildEvaluationPrepMeta(evaluationPlan),
      panels: renderedPanels,
    };
  }

  /**
   * Calls OpenRouter image-capable model and returns a data URL (or '' on failure).
   * Frontend already handles empty imageUrl with a placeholder.
   */
  async _renderImageSafely(prompt, visualContext = {}) {
    try {
      return await this._renderImage(prompt, visualContext);
    } catch (err) {
      console.warn('[LearningService] image render failed:', err?.message || err);
      return '';
    }
  }

  async _renderImage(prompt, visualContext = {}) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return '';

    const fullPrompt = buildAnalogyVisualPrompt(prompt, visualContext);
    const requestedModel = visualContext?.model || this.imageModel;
    const candidateModels = uniqueModelList([requestedModel, ...this.imageFallbackModels]);
    let lastError = null;

    for (const model of candidateModels) {
      try {
        const imageRef = await this._renderImageWithModel({ apiKey, model, fullPrompt });
        if (imageRef) return imageRef;
        console.warn(`[LearningService] _renderImage: no image found in response for model ${model}`);
      } catch (err) {
        lastError = err;
        if (!isImageModelFallbackError(err)) throw err;
        console.warn(`[LearningService] image model ${model} failed (${err?.response?.status || err?.message}); trying fallback.`);
      }
    }

    if (lastError) throw lastError;
    return '';
  }

  async _renderImageWithModel({ apiKey, model, fullPrompt }) {
    const body = {
      model,
      prompt: fullPrompt,
      n: 1,
    };

    if (String(model || '').startsWith('openai/')) {
      body.quality = process.env.OPENROUTER_IMAGE_QUALITY || 'low';
      body.background = process.env.OPENROUTER_IMAGE_BACKGROUND || 'opaque';
      const compression = Number(process.env.OPENROUTER_IMAGE_OUTPUT_COMPRESSION);
      if (Number.isFinite(compression)) {
        body.output_compression = Math.max(0, Math.min(100, Math.round(compression)));
      }
    } else if (String(model || '').startsWith('google/')) {
      body.aspect_ratio = process.env.OPENROUTER_IMAGE_ASPECT_RATIO || '4:3';
    }

    const resp = await axios.post(
      'https://openrouter.ai/api/v1/images',
      body,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://coursev.app',
          'X-Title': 'CourseV Learning',
        },
        timeout: imageTimeoutForModel(model),
      }
    );

    const imageFromImagesApi = extractImageRefFromImagesApiResponse(resp?.data);
    if (imageFromImagesApi) return imageFromImagesApi;

    const message = resp?.data?.choices?.[0]?.message;

    // Debug: log response shape without dumping large base64 blobs
    try {
      const shape = {
        model,
        endpoint: '/api/v1/images',
        dataItems: Array.isArray(resp?.data?.data)
          ? resp.data.data.map((item) => ({
            hasB64: Boolean(item?.b64_json || item?.base64_json || item?.image_base64),
            hasUrl: Boolean(item?.url || item?.image_url?.url),
            mimeType: item?.mime_type || item?.mimeType || item?.content_type || item?.contentType,
          }))
          : undefined,
        messageKeys: message ? Object.keys(message) : null,
        contentType: Array.isArray(message?.content) ? 'array' : typeof message?.content,
        contentLen: Array.isArray(message?.content) ? message.content.length : undefined,
        contentBlocks: Array.isArray(message?.content)
          ? message.content.map(b => ({ type: b?.type, hasImageUrl: !!b?.image_url, hasSource: !!b?.source, hasInlineData: !!b?.inlineData }))
          : undefined,
        hasImages: !!message?.images,
      };
      console.log('[LearningService] _renderImage response shape:', JSON.stringify(shape));
    } catch (_) { /* non-critical */ }

    // 1. OpenRouter images[] array (some providers, e.g. older Gemini variants)
    const fromImages = message?.images?.[0]?.image_url?.url;
    if (fromImages) return fromImages;

    // 2. Content is an array of blocks — most common for OpenRouter/Gemini/Anthropic
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        // Standard OpenRouter image_url block
        if (block?.type === 'image_url' && block.image_url?.url) return block.image_url.url;
        // OpenRouter output_image block
        if (block?.type === 'output_image' && block.image_url?.url) return block.image_url.url;
        // Anthropic-style: { type: 'image', source: { type: 'base64', media_type, data } }
        if (block?.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
          return `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`;
        }
        // Anthropic-style: { type: 'image', source: { type: 'url', url } }
        if (block?.type === 'image' && block.source?.url) return block.source.url;
        // Gemini native inlineData: { inlineData: { mimeType, data } }
        if (block?.inlineData?.data) {
          return `data:${block.inlineData.mimeType || 'image/png'};base64,${block.inlineData.data}`;
        }
        // Fallback: any block that carries a direct base64 data field
        if (block?.data && block?.mimeType) {
          return `data:${block.mimeType};base64,${block.data}`;
        }
      }
    }

    // 3. Content is a string — look for embedded markdown image or raw data URI
    if (typeof message?.content === 'string') {
      const mdImg = message.content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
      if (mdImg) return mdImg[1];
      const dataUri = message.content.match(/(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{20,})/);
      if (dataUri) return dataUri[1];
    }

    return '';
  }

  // ───────────────────────── VIDEO ─────────────────────────

  /**
   * Returns immediately with { status: 'processing', jobId } when a real video
   * model is configured so that the HTTP connection is never held open for
   * more than the time needed to build the script + poster (~30 s).
   * Clients must poll GET /api/learning/video/status/:jobId.
   *
   * When no video model is configured the slideshow is built inline and
   * returned with status: 'completed'.
   */
  async generateVideo({ courseId, topicId, taskId, userId, difficulty = DEFAULT_LEARNING_DIFFICULTY, targetCount = DEFAULT_EVALUATION_TARGET_COUNT }) {
    const normalizedDifficulty = normalizeLearningDifficulty(difficulty);
    const normalizedTargetCount = normalizeLearningTargetCount(targetCount);
    const sceneCount = videoSceneLimit(normalizedTargetCount);
    const requirements = { minScenes: sceneCount, requireEvaluationPrep: true };
    const descriptor = this._artifactDescriptor('video', { courseId, topicId, taskId });
    const stored = await this._readStoredArtifact('video', descriptor, requirements);
    if (stored) return stored;

    const existingJobId = videoJobsByArtifactKey.get(descriptor.cacheKey);
    if (existingJobId) {
      const existingJob = this.getVideoStatus(existingJobId);
      if (existingJob) return { jobId: existingJobId, ...existingJob };
      videoJobsByArtifactKey.delete(descriptor.cacheKey);
    }

    const ctxResult = await this.learningContextService.buildLearningContext({ courseId, topicId, taskId, userId, query: null, retrievalMode: 'hybrid' });
    if (ctxResult.isFail && ctxResult.isFail()) throw ctxResult.getError();
    const ctx = ctxResult.getValue ? ctxResult.getValue() : ctxResult;
    const sourceContext = buildSourceContext(ctx);
    const evaluationPlan = buildEvaluationReadinessPlan(ctx, { difficulty: normalizedDifficulty, targetCount: normalizedTargetCount, mode: 'video' });

    const llmResp = await this.llmAdapter.chat(
      VIDEO_SYSTEM_PROMPT,
      `Material disponible:\n\n${sourceContext}\n\n${evaluationPlan.text}\n\nGenera al menos ${sceneCount} escenas. Cada escena debe preparar una pregunta dificil del modulo de refuerzo.`,
      { model: this.textModel, temperature: 0.35, maxTokens: 6144 }
    );
    const script = safeParseJson(llmResp?.content);
    if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
      throw new Error('No fue posible interpretar el guion de video.');
    }

    script.scenes = ensureVideoSceneCount(script.scenes, sceneCount, ctx, evaluationPlan);

    const title = String(script.title || ctx?.topic?.name || 'Video educativo');
    const summary = String(script.summary || '').slice(0, 520);
    const durationSeconds = Math.max(75, Math.min(150, script.scenes.length * 10));
    const technicalHighlights = collectTechnicalHighlights(script);
    const sceneNotes = collectSceneNotes(script, sceneCount);
    const evaluationPrep = buildEvaluationPrepMeta(evaluationPlan);

    // ── Async path: video model configured ──────────────────
    // Return immediately after script generation so the HTTP connection is never
    // held open longer than ~20 s. Poster + video generation happen in the background.
    if (this.videoModel && process.env.OPENROUTER_API_KEY) {
      const jobId = `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      videoJobs.set(jobId, {
        status: 'processing',
        title,
        summary,
        posterUrl: '',
        durationSeconds,
        evaluationPrep,
        technicalHighlights,
        sceneNotes,
        artifactKey: descriptor.cacheKey,
        createdAt: Date.now(),
      });
      videoJobsByArtifactKey.set(descriptor.cacheKey, jobId);
      // Start background job — do NOT await so the HTTP response is sent immediately.
      this._startVideoJob(jobId, script, sourceContext, descriptor, requirements).catch((err) =>
        console.error('[LearningService] Unhandled background video job error:', err?.message)
      );
      return { jobId, status: 'processing', title, summary, posterUrl: '', durationSeconds, evaluationPrep, technicalHighlights, sceneNotes };
    }

    // No video model configured — surface an error so the UI shows a clear message.
    throw new Error('No hay modelo de video configurado. Contacta al administrador.');
  }

  /** Polls OpenRouter in the background, then uploads the video to R2 for permanent storage.
   * If video rendering fails (e.g. 402 insufficient credits, model unavailable) the job
   * automatically falls back to a narrated slideshow so the user always gets something. */
  async _startVideoJob(jobId, script, sourceContext = '', artifactDescriptor = null, requirements = {}) {
    const job = () => videoJobs.get(jobId);
    try {
      // Generate poster image in the background (non-blocking update to the job).
      const firstScene = script.scenes?.[0] || {};
      const firstTechnicalDetail = getTechnicalDetail(firstScene);
      const posterPromise = this._renderImageSafely(
        [
          String(firstScene.imagePrompt || script.title || ''),
          firstTechnicalDetail ? `External side-panel technical detail, do not render as image text: ${firstTechnicalDetail}` : '',
        ].filter(Boolean).join('\n'),
        { title: script.title, sourceContext, medium: 'video poster illustration' }
      ).then(async(posterUrl) => {
        const storedPosterUrl = artifactDescriptor
          ? await this._persistMediaSource(posterUrl, `${artifactDescriptor.mediaPrefix}/poster`, 'png')
          : posterUrl;
        const current = videoJobs.get(jobId);
        if (current) videoJobs.set(jobId, { ...current, posterUrl: storedPosterUrl });
        return storedPosterUrl;
      }).catch((err) => {
        console.warn(`[LearningService] Poster generation failed for job ${jobId}: ${err?.message || err}`);
        return '';
      });

      let videoUrl = null;
      try {
        const cdnUrl = await this._renderVideo(script, sourceContext);
        videoUrl = cdnUrl;
        // Download from the video provider CDN and upload to Cloudflare R2 for a permanent, CORS-safe URL.
        if (artifactDescriptor) {
          const publicUrl = await this._persistMediaSource(cdnUrl, `${artifactDescriptor.mediaPrefix}/video`, 'mp4');
          if (publicUrl) {
            videoUrl = publicUrl;
            console.info(`[LearningService] Video job ${jobId} persisted: ${publicUrl}`);
          }
        }
        const posterUrl = await posterPromise;
        const completed = await this._persistVideoMedia({ ...job(), status: 'completed', posterUrl, videoUrl }, artifactDescriptor);
        if (!hasUsableArtifactMedia('video', completed, requirements)) {
          throw new Error('No se pudo persistir el video ni una presentacion con imagenes.');
        }
        await this._writeStoredArtifact('video', artifactDescriptor, completed);
        videoJobs.set(jobId, { ...completed, artifactKey: artifactDescriptor?.cacheKey, createdAt: job()?.createdAt || Date.now() });
        console.info(`[LearningService] Video job ${jobId} completed.`);
      } catch (videoErr) {
        const httpStatus = videoErr?.response?.status;
        const insufficientCredits = httpStatus === 402;
        console.warn(`[LearningService] Video render failed for job ${jobId} (HTTP ${httpStatus || videoErr?.message}), falling back to slideshow. insufficientCredits=${insufficientCredits}`);
        const slides = await this._buildSlideshow(script, sourceContext, artifactDescriptor, requirements.minScenes);
        const posterUrl = await posterPromise;
        const completed = await this._persistVideoMedia({ ...job(), status: 'completed', posterUrl, slides, insufficientCredits }, artifactDescriptor);
        if (!hasUsableArtifactMedia('video', completed, requirements)) {
          throw new Error('No se pudo persistir el video ni una presentacion con imagenes.');
        }
        await this._writeStoredArtifact('video', artifactDescriptor, completed);
        videoJobs.set(jobId, { ...completed, artifactKey: artifactDescriptor?.cacheKey, createdAt: job()?.createdAt || Date.now() });
        console.info(`[LearningService] Video job ${jobId} completed as slideshow (${slides.length} slides).`);
      }
    } catch (err) {
      console.error(`[LearningService] Video job ${jobId} failed: ${err?.message}`);
      videoJobs.set(jobId, { ...job(), status: 'error', error: err.message });
    }
  }

  /** Generates one image per scene and returns a slides array as a fallback when video is unavailable. */
  async _buildSlideshow(script, sourceContext = '', artifactDescriptor = null, sceneCount = DEFAULT_VIDEO_SCENE_COUNT) {
    const scenes = script.scenes.slice(0, Math.max(MIN_VIDEO_SCENE_COUNT, Math.min(Number(sceneCount) || DEFAULT_VIDEO_SCENE_COUNT, MAX_VIDEO_SCENE_COUNT)));
    const perScene = Math.max(5, Math.round((script.scenes.length * 10) / Math.max(scenes.length, 1)));
    return await Promise.all(
      scenes.map(async (scene, index) => {
        const technicalDetail = getTechnicalDetail(scene);
        const renderedImageUrl = await this._renderImageSafely(
          [
            String(scene.imagePrompt || scene.narration || ''),
            technicalDetail ? `External side-panel technical detail, do not render as image text: ${technicalDetail}` : '',
          ].filter(Boolean).join('\n'),
          { title: script.title, sourceContext, medium: 'video slide illustration' }
        );
        return {
          narration: String(scene.narration || ''),
          technicalDetail: technicalDetail || undefined,
          imageUrl: artifactDescriptor
            ? await this._persistMediaSource(
              renderedImageUrl,
              `${artifactDescriptor.mediaPrefix}/slide_${String(index + 1).padStart(2, '0')}`,
              'png'
            )
            : renderedImageUrl,
          duration: perScene,
        };
      })
    );
  }

  /** Returns the current state of a video job, or null if not found / expired. */
  getVideoStatus(jobId) {
    const job = videoJobs.get(jobId);
    if (!job) return null;
    // Evict old finished jobs
    if (job.status !== 'processing' && Date.now() - job.createdAt > VIDEO_JOB_TTL_MS) {
      videoJobs.delete(jobId);
      if (job.artifactKey) videoJobsByArtifactKey.delete(job.artifactKey);
      return null;
    }
    const { artifactKey, ...clientJob } = job;
    return clientJob;
  }

  async _renderVideo(script, sourceContext = '') {
    const apiKey = process.env.OPENROUTER_API_KEY;

    // Build a concise text-to-video prompt from the script scenes
    const sceneSummary = script.scenes
      .slice(0, Math.min(8, script.scenes.length))
      .map((s, i) => {
        const technicalDetail = getTechnicalDetail(s);
        return [
          `Scene ${i + 1}: ${s.imagePrompt || s.narration || ''}`,
          technicalDetail ? `External side-panel technical content: ${technicalDetail}` : '',
        ].filter(Boolean).join('. ');
      })
      .join('. ');
    const technicalSummary = collectTechnicalHighlights(script).join(' | ');
    const prompt = buildAnalogyVisualPrompt(
      [
        script.summary || '',
        sceneSummary,
        technicalSummary ? `External technical content shown beside the video: ${technicalSummary}.` : '',
        'Smooth camera movement, coherent continuity between scenes, no decorative on-screen text; do not render code, formulas, tables, endpoints, commands, labels, captions, or any readable text inside the video.',
      ].filter(Boolean).join('. '),
      { title: script.title, sourceContext, medium: 'short educational video' }
    );

    // Step 1: Submit video generation job to OpenRouter /api/v1/videos
    const genResp = await axios.post(
      'https://openrouter.ai/api/v1/videos',
      {
        model: this.videoModel,
        prompt,
        duration: Number(process.env.OPENROUTER_VIDEO_DURATION) || 10,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://coursev.app',
          'X-Title': 'CourseV Learning',
        },
        timeout: 30_000,
      }
    );

    const pollingUrl = genResp?.data?.polling_url;
    if (!pollingUrl) throw new Error('No se obtuvo polling_url del proveedor de video.');

    // Step 2: Poll until the video is ready.
    // Seedance 2.0 can take several minutes. The frontend polls for ~8 min
    // (100 × 5 s) after receiving the initial response, so 5 min here is safe.
    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const pollIntervalMs = 6_000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const pollResp = await axios.get(pollingUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15_000,
      });
      const data = pollResp?.data;
      const jobStatus = data?.status;

      if (jobStatus === 'completed') {
        const url = data?.unsigned_urls?.[0] || data?.data?.[0]?.url;
        if (url) return url;
        throw new Error('Generación completada pero sin URL de video.');
      }
      if (jobStatus === 'failed' || jobStatus === 'error') {
        throw new Error(`Generación de video fallida: ${data?.error || 'error desconocido'}`);
      }
      console.info(`[LearningService] Video generation status: ${jobStatus}, waiting...`);
    }

    throw new Error('Tiempo de espera agotado esperando el video (máx 5 min).');
  }
}

export default LearningDomainService;
