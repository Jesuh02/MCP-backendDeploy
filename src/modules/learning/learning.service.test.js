import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningDomainService } from './learning.service.js';
import { Result } from '../../shared/Result.js';

test('generateComic keeps technical artifacts outside images and in the panel contract', async() => {
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
  assert.match(capturedSystemPrompt, /NO debe contener texto visible/);
  assert.match(capturedUserPrompt, /function sumar/);
  assert.match(capturedImagePrompt, /TEXT-FREE COMIC PANEL ONLY/);
  assert.match(capturedImagePrompt, /No written characters/);
  assert.doesNotMatch(capturedImagePrompt, /External side-panel technical detail/);
  assert.doesNotMatch(capturedImagePrompt, /Technical detail to make visible/);
  assert.doesNotMatch(capturedImagePrompt, /function sumar\(a, b\)/);
  assert.doesNotMatch(capturedImagePrompt, /return a \+ b|console\.log|whiteboard showing/i);
  assert.doesNotMatch(capturedImagePrompt, /Caption context|Dialogue context/);
  assert.deepEqual(capturedVisualContext, {
    title: '',
    sourceContext: '',
    medium: 'text-free comic panel illustration',
  });
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
