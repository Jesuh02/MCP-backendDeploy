import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { LearningDomainService } from './learning.service.js';
import { Result } from '../../shared/Result.js';

function createMemoryStorage() {
  const files = new Map();
  return {
    publicUrl: 'https://r2.test',
    isAvailable: () => true,
    isR2Url: (url) => String(url || '').startsWith('https://r2.test/'),
    getPublicUrl: (key) => `https://r2.test/${key}`,
    async uploadFile(content, key, contentType = 'application/octet-stream') {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      files.set(key, { buffer, contentType });
      return `https://r2.test/${key}`;
    },
    async fetchFile(key) {
      const file = files.get(key);
      if (!file) {
        const err = new Error('NotFound');
        err.name = 'NoSuchKey';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      const isText = /json|text|javascript|xml/i.test(file.contentType);
      return {
        buffer: file.buffer,
        contentType: file.contentType,
        content: isText ? file.buffer.toString('utf8') : file.buffer.toString('base64'),
      };
    },
    files,
  };
}

async function waitForCompletedVideo(service, jobId) {
  for (let i = 0; i < 30; i++) {
    const job = service.getVideoStatus(jobId);
    if (job && job.status !== 'processing') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('video job did not complete in time');
}

test('generateComic renders dialogue bubbles while keeping technical artifacts outside images', async() => {
  let capturedSystemPrompt = '';
  let capturedUserPrompt = '';
  const capturedImagePrompts = [];
  const capturedVisualContexts = [];

  const service = new LearningDomainService({
    learningContextService: {
      buildLearningContext: async() => Result.ok({
        topic: {
          name: 'Funciones en JavaScript',
          description: 'El tema explica como declarar funciones y retornar valores.',
        },
        task: {
          title: 'Crear una funcion sumar',
          description: 'El estudiante debe escribir codigo que reciba dos numeros y devuelva la suma.',
        },
        ragContent: 'Ejemplo: function sumar(a, b) { return a + b; } console.log(sumar(2, 3));',
      }),
    },
    llmAdapter: {
      chat: async(systemPrompt, userPrompt) => {
        capturedSystemPrompt = systemPrompt;
        capturedUserPrompt = userPrompt;
        return {
          content: JSON.stringify({
            title: 'La maquina de sumar',
            panels: [
              {
                caption: 'El taller compara una maquina reutilizable con una funcion.',
                dialogue: 'La funcion recibe dos piezas y entrega el resultado.',
                technicalDetail: 'function sumar(a, b) { return a + b; }',
                imagePrompt: 'A workshop where students see function sumar(a, b) { return a + b; } on a whiteboard.',
              },
            ],
          }),
        };
      },
    },
  });

  service._renderImageSafely = async(prompt, visualContext) => {
    capturedImagePrompts.push(prompt);
    capturedVisualContexts.push(visualContext);
    return 'data:image/png;base64,abc123';
  };

  const result = await service.generateComic({ courseId: 1, topicId: 2, taskId: 3, userId: 4 });
  const firstImagePrompt = capturedImagePrompts[0];
  const firstVisualContext = capturedVisualContexts[0];

  assert.match(capturedSystemPrompt, /technicalDetail/);
  assert.match(capturedSystemPrompt, /codigo|fragmentos de codigo/i);
  assert.match(capturedSystemPrompt, /Solo los globos de dialogo pueden tener texto/i);
  assert.match(capturedUserPrompt, /function sumar/);
  assert.match(capturedUserPrompt, /PLAN DE PREPARACION PARA REFUERZO/);
  assert.match(capturedUserPrompt, /multiple_choice/);
  assert.match(capturedUserPrompt, /fill_in_blank/);
  assert.match(capturedUserPrompt, /ordering/);
  assert.match(firstImagePrompt, /COMIC PANEL WITH READABLE SPANISH SPEECH BUBBLES/);
  assert.match(firstImagePrompt, /Exact speech bubble text: "La funcion recibe dos piezas y entrega el resultado\."/);
  assert.match(firstImagePrompt, /Only the speech bubbles may contain readable text/);
  assert.doesNotMatch(firstImagePrompt, /External side-panel technical detail/);
  assert.doesNotMatch(firstImagePrompt, /Technical detail to make visible/);
  assert.doesNotMatch(firstImagePrompt, /function sumar\(a, b\)/);
  assert.doesNotMatch(firstImagePrompt, /return a \+ b|console\.log|whiteboard showing/i);
  assert.doesNotMatch(firstImagePrompt, /Caption context|Dialogue context/);
  assert.equal(firstVisualContext.title, 'La maquina de sumar');
  assert.match(firstVisualContext.sourceContext, /Funciones en JavaScript/);
  assert.equal(firstVisualContext.medium, 'comic panel illustration with Spanish speech bubbles');
  assert.equal(firstVisualContext.allowSpeechText, true);
  assert.equal(firstVisualContext.model, 'openai/gpt-image-2');
  assert.equal(result.panels.length, 10);
  assert.equal(result.panels[0].dialogue, 'La funcion recibe dos piezas y entrega el resultado.');
  assert.equal(result.panels[0].technicalDetail, 'function sumar(a, b) { return a + b; }');
});

test('renderImage falls back when the configured image model returns 404', async() => {
  const originalPost = axios.post;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalImageModel = process.env.OPENROUTER_IMAGE_MODEL;
  const originalComicModel = process.env.OPENROUTER_COMIC_IMAGE_MODEL;
  const originalFallbacks = process.env.OPENROUTER_IMAGE_FALLBACK_MODELS;
  const calls = [];

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
  process.env.OPENROUTER_COMIC_IMAGE_MODEL = 'missing/image-model';
  delete process.env.OPENROUTER_IMAGE_FALLBACK_MODELS;

  axios.post = async(url, body) => {
    calls.push({ url, model: body.model });
    if (body.model === 'missing/image-model') {
      const err = new Error('Request failed with status code 404');
      err.response = { status: 404 };
      throw err;
    }
    return {
      data: {
        data: [{ b64_json: 'Zm9v', mime_type: 'image/png' }],
      },
    };
  };

  try {
    const service = new LearningDomainService({
      learningContextService: { buildLearningContext: async() => Result.ok({}) },
      llmAdapter: { chat: async() => ({ content: '{}' }) },
    });
    const imageUrl = await service._renderImage('Draw a warehouse analogy', { model: service.comicImageModel });
    assert.equal(imageUrl, 'data:image/png;base64,Zm9v');
    assert.deepEqual(calls.map((call) => call.model), ['missing/image-model', 'google/gemini-2.5-flash-image']);
    assert.ok(calls.every((call) => call.url === 'https://openrouter.ai/api/v1/images'));
  } finally {
    axios.post = originalPost;
    if (originalApiKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalApiKey;
    if (originalImageModel == null) delete process.env.OPENROUTER_IMAGE_MODEL; else process.env.OPENROUTER_IMAGE_MODEL = originalImageModel;
    if (originalComicModel == null) delete process.env.OPENROUTER_COMIC_IMAGE_MODEL; else process.env.OPENROUTER_COMIC_IMAGE_MODEL = originalComicModel;
    if (originalFallbacks == null) delete process.env.OPENROUTER_IMAGE_FALLBACK_MODELS; else process.env.OPENROUTER_IMAGE_FALLBACK_MODELS = originalFallbacks;
  }
});

test('renderImage falls back when gpt-image-2 times out', async() => {
  const originalPost = axios.post;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalImageModel = process.env.OPENROUTER_IMAGE_MODEL;
  const originalComicModel = process.env.OPENROUTER_COMIC_IMAGE_MODEL;
  const originalTimeout = process.env.OPENROUTER_IMAGE_TIMEOUT_MS;
  const originalFallbacks = process.env.OPENROUTER_IMAGE_FALLBACK_MODELS;
  const calls = [];

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
  process.env.OPENROUTER_COMIC_IMAGE_MODEL = 'openai/gpt-image-2';
  delete process.env.OPENROUTER_IMAGE_TIMEOUT_MS;
  delete process.env.OPENROUTER_IMAGE_FALLBACK_MODELS;

  axios.post = async(url, body, options) => {
    calls.push({ url, model: body.model, timeout: options.timeout, quality: body.quality });
    if (body.model === 'openai/gpt-image-2') {
      const err = new Error('timeout of 90000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    }
    return {
      data: {
        data: [{ b64_json: 'ZmFzdA==', mime_type: 'image/png' }],
      },
    };
  };

  try {
    const service = new LearningDomainService({
      learningContextService: { buildLearningContext: async() => Result.ok({}) },
      llmAdapter: { chat: async() => ({ content: '{}' }) },
    });
    const imageUrl = await service._renderImage('Draw a restaurant API analogy', { model: service.comicImageModel });
    assert.equal(imageUrl, 'data:image/png;base64,ZmFzdA==');
    assert.deepEqual(calls.map((call) => call.model), ['openai/gpt-image-2', 'google/gemini-2.5-flash-image']);
    assert.equal(calls[0].timeout, 180_000);
    assert.equal(calls[0].quality, 'low');
    assert.equal(calls[1].timeout, 90_000);
    assert.ok(calls.every((call) => call.url === 'https://openrouter.ai/api/v1/images'));
  } finally {
    axios.post = originalPost;
    if (originalApiKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalApiKey;
    if (originalImageModel == null) delete process.env.OPENROUTER_IMAGE_MODEL; else process.env.OPENROUTER_IMAGE_MODEL = originalImageModel;
    if (originalComicModel == null) delete process.env.OPENROUTER_COMIC_IMAGE_MODEL; else process.env.OPENROUTER_COMIC_IMAGE_MODEL = originalComicModel;
    if (originalTimeout == null) delete process.env.OPENROUTER_IMAGE_TIMEOUT_MS; else process.env.OPENROUTER_IMAGE_TIMEOUT_MS = originalTimeout;
    if (originalFallbacks == null) delete process.env.OPENROUTER_IMAGE_FALLBACK_MODELS; else process.env.OPENROUTER_IMAGE_FALLBACK_MODELS = originalFallbacks;
  }
});

test('slideshow scenes keep technical details in the side-panel contract', async() => {
  let capturedImagePrompt = '';
  const service = new LearningDomainService({
    learningContextService: { buildLearningContext: async() => Result.ok({}) },
    llmAdapter: { chat: async() => ({ content: '{}' }) },
  });

  service._renderImageSafely = async(prompt) => {
    capturedImagePrompt = prompt;
    return 'data:image/png;base64,slide';
  };

  const slides = await service._buildSlideshow({
    title: 'API de usuarios',
    scenes: [
      {
        narration: 'El mesero lleva la solicitud y vuelve con datos.',
        technicalDetail: 'GET /users/42 -> 200 { "name": "Ana" }',
        imagePrompt: 'A restaurant analogy where a waiter carries a request card to the kitchen.',
      },
    ],
  }, 'Tema: consumo de API REST');

  assert.equal(slides[0].technicalDetail, 'GET /users/42 -> 200 { "name": "Ana" }');
  assert.match(capturedImagePrompt, /External side-panel technical detail/);
  assert.doesNotMatch(capturedImagePrompt, /Technical detail to make visible/);
  assert.match(capturedImagePrompt, /GET \/users\/42/);
});

test('generateComic stores the rendered artifact in R2 and reuses it on the next request', async() => {
  const storage = createMemoryStorage();
  let llmCalls = 0;

  const service = new LearningDomainService({
    fileStoragePort: storage,
    learningContextService: {
      buildLearningContext: async() => Result.ok({
        topic: { name: 'Bases de datos', description: 'Consultas SQL basicas.' },
        task: { title: 'Consultar clientes', description: 'Usa SELECT y WHERE.' },
        ragContent: 'SELECT id, name FROM customers WHERE active = true;',
      }),
    },
    llmAdapter: {
      chat: async() => {
        llmCalls++;
        return {
          content: JSON.stringify({
            title: 'El almacen de datos',
            panels: [{
              caption: 'Una persona busca una caja exacta en un estante.',
              technicalDetail: 'SELECT id, name FROM customers WHERE active = true;',
              imagePrompt: 'A warehouse shelf with unlabeled boxes and a worker finding one box.',
            }],
          }),
        };
      },
    },
  });

  service._renderImageSafely = async() => 'data:image/png;base64,aGVsbG8=';

  const first = await service.generateComic({ courseId: 10, topicId: 20, taskId: 30, userId: 1 });
  const second = await service.generateComic({ courseId: 10, topicId: 20, taskId: 30, userId: 2 });

  assert.equal(llmCalls, 1);
  assert.equal(second.cached, true);
  assert.equal(first.title, second.title);
  assert.match(first.panels[0].imageUrl, /^https:\/\/r2\.test\/learning\/artifacts\//);
  assert.match(second.panels[0].imageUrl, /^https:\/\/r2\.test\/learning\/artifacts\//);
  assert.ok(storage.files.has('learning/artifacts/qa-develop/course_10/topic_20/task_30/comic.json'));
});

test('generateComic ignores a stored artifact without rendered images', async() => {
  const storage = createMemoryStorage();
  let llmCalls = 0;

  const service = new LearningDomainService({
    fileStoragePort: storage,
    learningContextService: {
      buildLearningContext: async() => Result.ok({
        topic: { name: 'Algoritmos', description: 'Pasos y decisiones.' },
        task: { title: 'Crear un flujo', description: 'Explicar un if.' },
        ragContent: 'if (score >= 3) return "aprobado";',
      }),
    },
    llmAdapter: {
      chat: async() => {
        llmCalls++;
        return {
          content: JSON.stringify({
            title: 'La receta con decisiones',
            panels: [{
              caption: 'Una receta cambia de paso segun el resultado.',
              technicalDetail: 'if (score >= 3) return "aprobado";',
              imagePrompt: 'A kitchen recipe line where a cook chooses the next step.',
            }],
          }),
        };
      },
    },
  });

  const descriptor = service._artifactDescriptor('comic', { courseId: 12, topicId: 24, taskId: 36 });
  await storage.uploadFile(
    Buffer.from(JSON.stringify({
      version: 1,
      kind: 'comic',
      data: {
        title: 'Comic roto',
        panels: [{ caption: 'Sin imagen', imageUrl: '' }],
      },
    })),
    descriptor.cacheKey,
    'application/json',
  );

  service._renderImageSafely = async() => 'data:image/png;base64,bmV3';

  const result = await service.generateComic({ courseId: 12, topicId: 24, taskId: 36, userId: 1 });

  assert.equal(llmCalls, 1);
  assert.equal(result.title, 'La receta con decisiones');
  assert.match(result.panels[0].imageUrl, /^https:\/\/r2\.test\/learning\/artifacts\//);
});

test('generateVideo returns a completed stored artifact without calling the LLM', async() => {
  const storage = createMemoryStorage();
  let llmCalls = 0;

  const service = new LearningDomainService({
    fileStoragePort: storage,
    learningContextService: {
      buildLearningContext: async() => {
        throw new Error('context should not be built when artifact exists');
      },
    },
    llmAdapter: {
      chat: async() => {
        llmCalls++;
        return { content: '{}' };
      },
    },
  });

  const descriptor = service._artifactDescriptor('video', { courseId: 10, topicId: 20, taskId: 30 });
  await storage.uploadFile(
    Buffer.from(JSON.stringify({
      version: 1,
      kind: 'video',
      data: {
        title: 'Video guardado',
        summary: 'Resumen persistido.',
        status: 'completed',
        videoUrl: 'https://r2.test/learning/artifacts/qa-develop/course_10/topic_20/task_30/video/video.mp4',
        durationSeconds: 60,
        sceneNotes: Array.from({ length: 10 }, (_, index) => ({ narration: `Escena ${index + 1}` })),
      },
    })),
    descriptor.cacheKey,
    'application/json',
  );

  const result = await service.generateVideo({ courseId: 10, topicId: 20, taskId: 30, userId: 1 });

  assert.equal(llmCalls, 0);
  assert.equal(result.cached, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.videoUrl, 'https://r2.test/learning/artifacts/qa-develop/course_10/topic_20/task_30/video/video.mp4');
});

test('generateVideo persists rendered video, poster, and artifact JSON in R2', async() => {
  const storage = createMemoryStorage();
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';

  const service = new LearningDomainService({
    fileStoragePort: storage,
    learningContextService: {
      buildLearningContext: async() => Result.ok({
        topic: { name: 'Consumo de API', description: 'Peticiones HTTP y respuestas JSON.' },
        task: { title: 'Consultar usuarios', description: 'Hacer GET a un endpoint.' },
        ragContent: 'GET /users/42 -> 200 { "name": "Ana" }',
      }),
    },
    llmAdapter: {
      chat: async() => ({
        content: JSON.stringify({
          title: 'El restaurante de datos',
          summary: 'Una analogia visual para explicar una API.',
          scenes: [{
            narration: 'El mesero lleva una solicitud a cocina y vuelve con el plato correcto.',
            technicalDetail: 'GET /users/42 -> 200 { "name": "Ana" }',
            imagePrompt: 'A restaurant waiter carrying an order card to the kitchen.',
          }],
        }),
      }),
    },
  });

  service._renderImageSafely = async() => 'data:image/png;base64,cG9zdGVy';
  service._renderVideo = async() => 'data:video/mp4;base64,dmlkZW8=';

  try {
    const initial = await service.generateVideo({ courseId: 11, topicId: 22, taskId: 33, userId: 1 });
    assert.equal(initial.status, 'processing');

    const completed = await waitForCompletedVideo(service, initial.jobId);
    assert.equal(completed.status, 'completed');
    assert.match(completed.videoUrl, /^https:\/\/r2\.test\/learning\/artifacts\/qa-develop\/course_11\/topic_22\/task_33\/video\/video\.mp4$/);
    assert.match(completed.posterUrl, /^https:\/\/r2\.test\/learning\/artifacts\/qa-develop\/course_11\/topic_22\/task_33\/video\/poster\.png$/);
    assert.ok(storage.files.has('learning/artifacts/qa-develop/course_11/topic_22/task_33/video/video.mp4'));
    assert.ok(storage.files.has('learning/artifacts/qa-develop/course_11/topic_22/task_33/video/poster.png'));
    assert.ok(storage.files.has('learning/artifacts/qa-develop/course_11/topic_22/task_33/video.json'));
  } finally {
    if (originalApiKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalApiKey;
  }
});
