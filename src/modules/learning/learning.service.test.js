import test from 'node:test';
import assert from 'node:assert/strict';
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

test('generateComic renders dialogue bubbles while keeping technical artifacts outside images', async() => {
  let capturedSystemPrompt = '';
  let capturedUserPrompt = '';
  let capturedImagePrompt = '';
  let capturedVisualContext = null;

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
    capturedImagePrompt = prompt;
    capturedVisualContext = visualContext;
    return 'data:image/png;base64,abc123';
  };

  const result = await service.generateComic({ courseId: 1, topicId: 2, taskId: 3, userId: 4 });

  assert.match(capturedSystemPrompt, /technicalDetail/);
  assert.match(capturedSystemPrompt, /codigo|fragmentos de codigo/i);
  assert.match(capturedSystemPrompt, /Solo los globos de dialogo pueden tener texto/i);
  assert.match(capturedUserPrompt, /function sumar/);
  assert.match(capturedImagePrompt, /COMIC PANEL WITH READABLE SPANISH SPEECH BUBBLES/);
  assert.match(capturedImagePrompt, /Exact speech bubble text: "La funcion recibe dos piezas y entrega el resultado\."/);
  assert.match(capturedImagePrompt, /Only the speech bubbles may contain readable text/);
  assert.doesNotMatch(capturedImagePrompt, /External side-panel technical detail/);
  assert.doesNotMatch(capturedImagePrompt, /Technical detail to make visible/);
  assert.doesNotMatch(capturedImagePrompt, /function sumar\(a, b\)/);
  assert.doesNotMatch(capturedImagePrompt, /return a \+ b|console\.log|whiteboard showing/i);
  assert.doesNotMatch(capturedImagePrompt, /Caption context|Dialogue context/);
  assert.equal(capturedVisualContext.title, 'La maquina de sumar');
  assert.match(capturedVisualContext.sourceContext, /Funciones en JavaScript/);
  assert.equal(capturedVisualContext.medium, 'comic panel illustration with Spanish speech bubbles');
  assert.equal(capturedVisualContext.allowSpeechText, true);
  assert.equal(capturedVisualContext.model, 'openai/gpt-image-2');
  assert.equal(result.panels[0].dialogue, 'La funcion recibe dos piezas y entrega el resultado.');
  assert.equal(result.panels[0].technicalDetail, 'function sumar(a, b) { return a + b; }');
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
