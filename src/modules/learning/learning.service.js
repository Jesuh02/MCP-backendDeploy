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

const DEFAULT_PANEL_COUNT = 6;

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

6. Genera entre 4 y 8 paneles con principio, desarrollo y cierre.

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

6. Entre 5 y 8 escenas con principio, desarrollo y cierre.

7. CODIGO PROGRESIVO: El codigo en "technicalDetail" debe PROGRESAR con la historia. Cada escena muestra una parte diferente del codigo que se relaciona con esa situacion especifica.`;

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

function collectSceneNotes(script) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  return scenes.slice(0, 8).map((scene) => {
    const note = {
      narration: String(scene?.narration || '').slice(0, 420),
    };
    const technicalDetail = getTechnicalDetail(scene);
    if (technicalDetail) note.technicalDetail = technicalDetail;
    return note;
  }).filter((scene) => scene.narration || scene.technicalDetail);
}

function buildAnalogyVisualPrompt(prompt, { title = '', sourceContext = '', medium = 'image' } = {}) {
  const isTextFree = /text-free/i.test(medium);
  const subject = compactText([title, sourceContext, prompt].filter(Boolean).join(' '), 1400);
  const hints = pickAnalogyHints(subject).join('; ');
  const technicalHints = isTextFree ? '' : pickTechnicalVisualHints(subject).join('; ');
  const contextHint = compactText(sourceContext, 650);

  return [
    `Create a ${medium} for an educational lesson.`,
    title ? `Lesson title: ${title}.` : '',
    contextHint ? `Relevant context: ${contextHint}.` : '',
    `Core scene request: ${compactText(prompt, 700)}.`,
    `Use a concrete real-life analogy: ${hints}.`,
    technicalHints ? `External side-panel technical requirement: ${technicalHints}. The story must remain an analogy, and the actual code/data/formula/endpoint must be displayed by the UI outside the image.` : '',
    'Make the abstract idea visible through physical objects, people interacting, clear cause-and-effect, and a single focused environment.',
    'Do not render any readable text inside the image or video: no code, letters, numbers, formulas, table text, endpoint paths, JSON keys, commands, diagram labels, captions, speech bubbles, logos, or watermarks.',
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
    // Best-in-class OpenRouter models, overridable by env
    this.imageModel = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
    this.textModel = process.env.OPENROUTER_LEARNING_MODEL || process.env.OPENROUTER_CHAT_MODEL || 'qwen/qwen-2.5-72b-instruct';
    this.videoModel = process.env.OPENROUTER_VIDEO_MODEL || 'kwaivgi/kling-v3.0-pro';
  }

  // ───────────────────────── COMIC ─────────────────────────
  async generateComic({ courseId, topicId, taskId, userId }) {
    const ctxResult = await this.learningContextService.buildLearningContext({ courseId, topicId, taskId, userId });
    if (ctxResult.isFail && ctxResult.isFail()) {
      throw ctxResult.getError();
    }
    const ctx = ctxResult.getValue ? ctxResult.getValue() : ctxResult;
    const sourceContext = buildSourceContext(ctx);

    const userPrompt =
      `Construye una historieta educativa basada EXCLUSIVAMENTE en este material:\n\n` +
      `${sourceContext}\n\n` +
      `Genera al menos ${DEFAULT_PANEL_COUNT} paneles.`;

    const llmResp = await this.llmAdapter.chat(
      COMIC_SYSTEM_PROMPT,
      userPrompt,
      { model: this.textModel, temperature: 0.4, maxTokens: 4096 }
    );
    const script = safeParseJson(llmResp?.content);
    if (!script || !Array.isArray(script.panels) || !script.panels.length) {
      throw new Error('No fue posible interpretar la respuesta del modelo de texto.');
    }

    const title = String(script.title || ctx?.topic?.name || 'Cómic educativo');

    // Generate images in parallel (small fanout to respect rate limits)
    const panels = script.panels.slice(0, 8);
    const renderedPanels = await Promise.all(
      panels.map(async (p) => {
        const technicalDetail = getTechnicalDetail(p);
        const panelPrompt = buildTextFreeComicImageRequest(p);
        const imageUrl = await this._renderImageSafely(
          String(panelPrompt || title),
          { title: '', sourceContext: '', medium: 'text-free comic panel illustration' }
        );
        return {
          caption: String(p.caption || '').slice(0, 320),
          dialogue: p.dialogue ? String(p.dialogue).slice(0, 240) : undefined,
          technicalDetail: technicalDetail || undefined,
          imageUrl,
        };
      })
    );

    return {
      jobId: `comic_${Date.now()}`,
      title,
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

    const resp = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: this.imageModel,
        modalities: ['image', 'text'],
        messages: [{ role: 'user', content: fullPrompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://coursev.app',
          'X-Title': 'CourseV Learning',
        },
        timeout: 90_000,
      }
    );

    const message = resp?.data?.choices?.[0]?.message;

    // Debug: log response shape without dumping large base64 blobs
    try {
      const shape = {
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

    console.warn('[LearningService] _renderImage: no image found in response for model', this.imageModel);
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
  async generateVideo({ courseId, topicId, taskId, userId }) {
    const ctxResult = await this.learningContextService.buildLearningContext({ courseId, topicId, taskId, userId });
    if (ctxResult.isFail && ctxResult.isFail()) throw ctxResult.getError();
    const ctx = ctxResult.getValue ? ctxResult.getValue() : ctxResult;
    const sourceContext = buildSourceContext(ctx);

    const llmResp = await this.llmAdapter.chat(
      VIDEO_SYSTEM_PROMPT,
      `Material disponible:\n\n${sourceContext}`,
      { model: this.textModel, temperature: 0.4, maxTokens: 3072 }
    );
    const script = safeParseJson(llmResp?.content);
    if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
      throw new Error('No fue posible interpretar el guion de video.');
    }

    const title = String(script.title || ctx?.topic?.name || 'Video educativo');
    const summary = String(script.summary || '').slice(0, 520);
    const durationSeconds = Math.max(45, Math.min(120, script.scenes.length * 10));
    const technicalHighlights = collectTechnicalHighlights(script);
    const sceneNotes = collectSceneNotes(script);

    // ── Async path: video model configured ──────────────────
    // Return immediately after script generation so the HTTP connection is never
    // held open longer than ~20 s. Poster + video generation happen in the background.
    if (this.videoModel && process.env.OPENROUTER_API_KEY) {
      const jobId = `video_${Date.now()}`;
      videoJobs.set(jobId, {
        status: 'processing',
        title,
        summary,
        posterUrl: '',
        durationSeconds,
        technicalHighlights,
        sceneNotes,
        createdAt: Date.now(),
      });
      // Start background job — do NOT await so the HTTP response is sent immediately.
      this._startVideoJob(jobId, script, sourceContext).catch((err) =>
        console.error('[LearningService] Unhandled background video job error:', err?.message)
      );
      return { jobId, status: 'processing', title, summary, posterUrl: '', durationSeconds, technicalHighlights, sceneNotes };
    }

    // No video model configured — surface an error so the UI shows a clear message.
    throw new Error('No hay modelo de video configurado. Contacta al administrador.');
  }

  /** Polls OpenRouter in the background, then uploads the video to R2 for permanent storage.
   * If video rendering fails (e.g. 402 insufficient credits, model unavailable) the job
   * automatically falls back to a narrated slideshow so the user always gets something. */
  async _startVideoJob(jobId, script, sourceContext = '') {
    const job = () => videoJobs.get(jobId);
    try {
      // Generate poster image in the background (non-blocking update to the job).
      const firstScene = script.scenes?.[0] || {};
      const firstTechnicalDetail = getTechnicalDetail(firstScene);
      this._renderImageSafely(
        [
          String(firstScene.imagePrompt || script.title || ''),
          firstTechnicalDetail ? `External side-panel technical detail, do not render as image text: ${firstTechnicalDetail}` : '',
        ].filter(Boolean).join('\n'),
        { title: script.title, sourceContext, medium: 'video poster illustration' }
      ).then((posterUrl) => {
        const current = videoJobs.get(jobId);
        if (current) videoJobs.set(jobId, { ...current, posterUrl });
      });

      let videoUrl = null;
      try {
        const cdnUrl = await this._renderVideo(script, sourceContext);
        videoUrl = cdnUrl;
        // Download from Kling CDN and upload to Cloudflare R2 for a permanent, CORS-safe URL.
        if (this.fileStoragePort) {
          try {
            const dlResp = await axios.get(cdnUrl, { responseType: 'arraybuffer', timeout: 120_000 });
            const buffer = Buffer.from(dlResp.data);
            const contentType = dlResp.headers['content-type'] || 'video/mp4';
            const { publicUrl } = await this.fileStoragePort.uploadBufferWithAutoKey(
              buffer, `learning_${jobId}.mp4`, contentType, 'learning/videos'
            );
            videoUrl = publicUrl;
            console.info(`[LearningService] Video job ${jobId} uploaded to R2: ${publicUrl}`);
          } catch (r2Err) {
            console.warn(`[LearningService] R2 upload failed for job ${jobId}, falling back to CDN URL: ${r2Err?.message}`);
          }
        }
        videoJobs.set(jobId, { ...job(), status: 'completed', videoUrl });
        console.info(`[LearningService] Video job ${jobId} completed.`);
      } catch (videoErr) {
        const httpStatus = videoErr?.response?.status;
        const insufficientCredits = httpStatus === 402;
        console.warn(`[LearningService] Video render failed for job ${jobId} (HTTP ${httpStatus || videoErr?.message}), falling back to slideshow. insufficientCredits=${insufficientCredits}`);
        const slides = await this._buildSlideshow(script, sourceContext);
        videoJobs.set(jobId, { ...job(), status: 'completed', slides, insufficientCredits });
        console.info(`[LearningService] Video job ${jobId} completed as slideshow (${slides.length} slides).`);
      }
    } catch (err) {
      console.error(`[LearningService] Video job ${jobId} failed: ${err?.message}`);
      videoJobs.set(jobId, { ...job(), status: 'error', error: err.message });
    }
  }

  /** Generates one image per scene and returns a slides array as a fallback when video is unavailable. */
  async _buildSlideshow(script, sourceContext = '') {
    const scenes = script.scenes.slice(0, 8);
    const perScene = Math.max(5, Math.round((script.scenes.length * 10) / scenes.length));
    return await Promise.all(
      scenes.map(async (scene) => {
        const technicalDetail = getTechnicalDetail(scene);
        return {
          narration: String(scene.narration || ''),
          technicalDetail: technicalDetail || undefined,
          imageUrl: await this._renderImageSafely(
            [
              String(scene.imagePrompt || scene.narration || ''),
              technicalDetail ? `External side-panel technical detail, do not render as image text: ${technicalDetail}` : '',
            ].filter(Boolean).join('\n'),
            { title: script.title, sourceContext, medium: 'video slide illustration' }
          ),
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
      return null;
    }
    return job;
  }

  async _renderVideo(script, sourceContext = '') {
    const apiKey = process.env.OPENROUTER_API_KEY;

    // Build a concise text-to-video prompt from the script scenes
    const sceneSummary = script.scenes
      .slice(0, 4)
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
    // Kling v3.0 Pro typically takes 3-5 min. The frontend polls for ~8 min
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
