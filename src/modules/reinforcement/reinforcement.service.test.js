import test from 'node:test';
import assert from 'node:assert/strict';
import { ReinforcementDomainService } from './reinforcement.service.js';
import { Result } from '../../shared/Result.js';

test('generateQuestions returns local fallback questions when the LLM is unauthorized', async() => {
    const service = new ReinforcementDomainService({
        reinforcementRepository: {},
        llmPort: {
            chat: async() => {
                const error = new Error('User not found.');
                error.code = 401;
                throw error;
            },
        },
        learningContextService: {
            buildLearningContext: async() => Result.ok({
                topic: {
                    name: 'Sintaxis y semantica de Python',
                    description: 'El tema explica indentacion, expresiones, instrucciones y significado del codigo.',
                },
                task: {
                    title: 'Ejercicios de sintaxis y semantica',
                    description: 'La tarea pide analizar fragmentos de Python y justificar su comportamiento.',
                },
                ragContent: [
                    'Python utiliza la indentacion para delimitar bloques de control y funciones.',
                    'La sintaxis define la forma valida del codigo, mientras la semantica describe su significado.',
                    'Una expresion se evalua para producir un valor y una instruccion produce una accion.',
                    'El estudiante debe justificar por que un fragmento es valido y que efecto produce.',
                ].join(' '),
                ragChunks: 1,
                ragFiles: ['guia_python.docx'],
                existingQuestions: [],
            }),
        },
    });
    service._backgroundSave = async() => {};

    const result = await service.generateQuestions(5, 302, 4838, 2090, 'HARD', 10, true);

    assert.equal(result.isOk(), true);
    const data = result.getValue();
    assert.equal(data.count, 10);
    assert.equal(data.questions.length, 10);
    for (const question of data.questions) {
        assert.equal(question.type, 'multiple_choice');
        assert.ok(question.question.length >= 8);
        assert.equal(question.options.length, 4);
        assert.ok(Number.isInteger(question.correctIndex));
        assert.ok(question.correctIndex >= 0 && question.correctIndex < question.options.length);
        assert.equal(new Set(question.options.map(option => option.toLowerCase().trim())).size, 4);
    }
});
