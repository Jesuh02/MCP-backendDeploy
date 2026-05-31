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

// In-process async job store for video generation.
// Single-instance deployments (Railway) are fine; for multi-instance add Redis.
const videoJobs = new Map(); // jobId -> { status, title, posterUrl, videoUrl?, slides?, durationSeconds, error?, createdAt }
const VIDEO_JOB_TTL_MS = 30 * 60 * 1000; // 30 min

const COMIC_SYSTEM_PROMPT = `Eres un guionista pedagógico que transforma material de estudio en una historieta (cómic) didáctica.
Devuelves SIEMPRE un único objeto JSON válido (sin Markdown, sin texto fuera del JSON) con la forma exacta:
{
  "title": "Título corto y atractivo",
  "panels": [
    {
      "caption": "Narración del panel en 1-2 frases (max 220 caracteres). En español.",
      "dialogue": "Diálogo opcional entre personajes, breve (puede omitirse).",
      "imagePrompt": "Descripción visual en INGLÉS, estilo cartoon educativo, colores vivos, sin texto en la imagen, 4:3."
    }
  ]
}
Reglas:
- Genera entre 4 y 8 paneles que cuenten una historia con principio, desarrollo y cierre.
- Apóyate ESTRICTAMENTE en los materiales (tema, tarea, fragmentos RAG) suministrados.
- Si los materiales son escasos, complementa con conocimiento general del tema, sin inventar datos contradictorios.
- En "imagePrompt": describe escena, personajes, paleta, composición; evita texto incrustado.`;

const VIDEO_SYSTEM_PROMPT = `Eres un guionista pedagógico de video corto (60-90 s).
Devuelves SIEMPRE un único objeto JSON válido (sin Markdown), con la forma:
{
  "title": "Título atractivo",
  "summary": "Resumen del video en 1-2 frases",
  "scenes": [
    { "narration": "Texto que narra la voz en off", "imagePrompt": "Escena visual en INGLÉS, estilo cartoon educativo, colores vivos, sin texto" }
  ]
}
Entre 5 y 8 escenas. Apóyate en los materiales aportados.`;

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
        const imageUrl = await this._renderImageSafely(
          String(p.imagePrompt || p.caption || title)
        );
        return {
          caption: String(p.caption || '').slice(0, 320),
          dialogue: p.dialogue ? String(p.dialogue).slice(0, 240) : undefined,
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
  async _renderImageSafely(prompt) {
    try {
      return await this._renderImage(prompt);
    } catch (err) {
      console.warn('[LearningService] image render failed:', err?.message || err);
      return '';
    }
  }

  async _renderImage(prompt) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return '';

    const fullPrompt =
      `${prompt}. Style: friendly cartoon illustration, vibrant colors, soft shading, ` +
      `cinematic composition, 4:3 aspect ratio, no text, no watermarks.`;

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
    const durationSeconds = Math.max(45, Math.min(120, script.scenes.length * 10));

    // ── Async path: video model configured ──────────────────
    // Return immediately after script generation so the HTTP connection is never
    // held open longer than ~20 s. Poster + video generation happen in the background.
    if (this.videoModel && process.env.OPENROUTER_API_KEY) {
      const jobId = `video_${Date.now()}`;
      videoJobs.set(jobId, {
        status: 'processing',
        title,
        posterUrl: '',
        durationSeconds,
        createdAt: Date.now(),
      });
      // Start background job — do NOT await so the HTTP response is sent immediately.
      this._startVideoJob(jobId, script).catch((err) =>
        console.error('[LearningService] Unhandled background video job error:', err?.message)
      );
      return { jobId, status: 'processing', title, posterUrl: '', durationSeconds };
    }

    // No video model configured — surface an error so the UI shows a clear message.
    throw new Error('No hay modelo de video configurado. Contacta al administrador.');
  }

  /** Polls OpenRouter in the background, then uploads the video to R2 for permanent storage.
   * If video rendering fails (e.g. 402 insufficient credits, model unavailable) the job
   * automatically falls back to a narrated slideshow so the user always gets something. */
  async _startVideoJob(jobId, script) {
    const job = () => videoJobs.get(jobId);
    try {
      // Generate poster image in the background (non-blocking update to the job).
      const firstScene = script.scenes?.[0] || {};
      this._renderImageSafely(String(firstScene.imagePrompt || script.title || '')).then((posterUrl) => {
        const current = videoJobs.get(jobId);
        if (current) videoJobs.set(jobId, { ...current, posterUrl });
      });

      let videoUrl = null;
      try {
        const cdnUrl = await this._renderVideo(script);
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
        const slides = await this._buildSlideshow(script);
        videoJobs.set(jobId, { ...job(), status: 'completed', slides, insufficientCredits });
        console.info(`[LearningService] Video job ${jobId} completed as slideshow (${slides.length} slides).`);
      }
    } catch (err) {
      console.error(`[LearningService] Video job ${jobId} failed: ${err?.message}`);
      videoJobs.set(jobId, { ...job(), status: 'error', error: err.message });
    }
  }

  /** Generates one image per scene and returns a slides array as a fallback when video is unavailable. */
  async _buildSlideshow(script) {
    const scenes = script.scenes.slice(0, 8);
    const perScene = Math.max(5, Math.round((script.scenes.length * 10) / scenes.length));
    return await Promise.all(
      scenes.map(async (scene) => ({
        narration: String(scene.narration || ''),
        imageUrl: await this._renderImageSafely(String(scene.imagePrompt || scene.narration || '')),
        duration: perScene,
      }))
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

  async _renderVideo(script) {
    const apiKey = process.env.OPENROUTER_API_KEY;

    // Build a concise text-to-video prompt from the script scenes
    const sceneSummary = script.scenes
      .slice(0, 4)
      .map((s, i) => `Scene ${i + 1}: ${s.imagePrompt}`)
      .join('. ');
    const prompt = `Educational video about "${script.title}". ${sceneSummary}`;

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
