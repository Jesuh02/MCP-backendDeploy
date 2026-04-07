/**
 * Test: Bug fix for carry-before-continue ordering in arithmetic procedures.
 * Validates the ArithmeticProcedureOrderRule works correctly.
 */
import { OrderingQuestionValidator } from './src/shared/math/OrderingQuestionValidator.js';
import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';
import { ValidationPipeline } from './src/shared/math/ValidationPipeline.js';

let passed = 0;
let failed = 0;

function assert(condition, label, info = '') {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${label}${info ? ' | ' + info : ''}`);
        failed++;
    }
}

// ─── Test 1: Exact bug reported by user ───────────────────────────────────────
console.log('\n═══ TEST 1: Bug exacto reportado (acarreos/continuar invertidos) ═══');

const wrongOrder = [
    'Alinear decimales',
    'Sumar desde la derecha',
    'Continuar sumando', // ← WRONG: should be step 4
    'Llevar acarreos', // ← WRONG: should be step 3
    'Escribir resultado final'
];
const question = 'Ordena los pasos del proceso de suma de números con decimales:';
const result1 = OrderingQuestionValidator.validateQuestion(question, wrongOrder);
assert(result1.valid, 'Pregunta procesada como valida (no rechazada)');
assert(result1.corrections && result1.corrections.length > 0, 'Se aplicaron correcciones');
const carryIdx = (result1.items || []).findIndex(s => /acarreo/i.test(s));
const continueIdx = (result1.items || []).findIndex(s => /continuar/i.test(s));
assert(carryIdx !== -1 && continueIdx !== -1, 'Ambos pasos encontrados en la salida');
assert(carryIdx < continueIdx, 'Acarreos (pos ' + (carryIdx + 1) + ') ANTES de continuar (pos ' + (continueIdx + 1) + ')');

// ─── Test 2: Correct order should NOT be modified ─────────────────────────────
console.log('\n═══ TEST 2: Orden CORRECTO no debe modificarse ═══');

const correctOrder = [
    'Alinear los números decimales verticalmente',
    'Sumar desde la derecha (columna de unidades)',
    'Llevar los acarreos a la siguiente columna cuando el resultado sea ≥10',
    'Continuar sumando la siguiente columna incorporando el acarreo',
    'Escribir el resultado final'
];
const result2 = OrderingQuestionValidator.validateQuestion(question, correctOrder);
assert(result2.valid, 'Pregunta válida');
const noChange = !result2.corrections || result2.corrections.length === 0;
assert(noChange, 'No se aplicaron correcciones (orden ya era correcto)');
const carry2 = (result2.items || correctOrder).findIndex(s => /acarreo/i.test(s));
const cont2 = (result2.items || correctOrder).findIndex(s => /continuar/i.test(s));
assert(carry2 < cont2, 'Acarreo sigue antes de continuar');
// ─── Test 3: ValidationPipeline rejects if wrong order slips through ──────────
console.log('\n═══ TEST 3: ValidationPipeline dependency check rechaza orden malo ═══');

const pipeline = ValidationPipeline.getInstance();

// Simulate: fixOrderingQuestion is given the WRONG sequence as "correct"
// (meaning OrderingQuestionValidator failed to catch it - safety net test)
const wrongItems = ['Alinear', 'Sumar', 'Continuar sumando la siguiente columna', 'Llevar acarreos pendientes', 'Escribir resultado'];
// Shuffle to simulate displayed items
const shuffled = ['Llevar acarreos pendientes', 'Sumar', 'Continuar sumando la siguiente columna', 'Alinear', 'Escribir resultado'];
// correctOrder that encodes wrong sequence (swap carry and continue intentionally)
// wrongSequence = [Alinear, Sumar, Continuar, Llevar, Escribir]
// In shuffled: Alinear=3, Sumar=1, Continuar=2, Llevar=0, Escribir=4
const badCorrectOrder = [3, 1, 2, 0, 4]; // This encodes: Alinear→Sumar→Continuar→Llevar→Escribir (WRONG)

const badQ = {
    type: 'ordering',
    question: 'Ordena los pasos de la suma con acarreos:',
    items: shuffled,
    correctOrder: badCorrectOrder,
    explanation: 'steps',
};

const pipelineResult = pipeline.validate(badQ);
assert(pipelineResult === null, 'Pipeline RECHAZA la pregunta con orden incorrecto de acarreos');


// ─── Test 4: buildOrderingExplanation - procedural (not numeric) ─────────────
console.log('\n═══ TEST 4: buildOrderingExplanation - preguntas procedurales ═══');

const procSteps = ['Alinear decimales', 'Sumar desde derecha', 'Llevar acarreos', 'Continuar sumando', 'Escribir resultado'];
const procExplanation = QuizMathValidator.buildOrderingExplanation(procSteps, 'El procedimiento de suma es secuencial.');

assert(!procExplanation.includes('ascendente') && !procExplanation.includes('descendente'),
    'Explicacion procedimental NO dice ascendente/descendente');
assert(procExplanation.includes('1.') || procExplanation.includes('pasos'),
    'Explicacion lista los pasos numerados');
assert(procExplanation.includes('Llevar acarreos'),
    'Explicacion menciona el paso de acarreos');
console.log('  Explicacion generada:', procExplanation.split('\n').slice(0, 3).join(' | '));


// ─── Test 5: buildOrderingExplanation - numeric sorting (unchanged behavior) ─
console.log('\n═══ TEST 5: buildOrderingExplanation - ordenamiento numérico ═══');

const numericSteps = ['1,234', '2,456', '3,678', '4,890'];
const numExplanation = QuizMathValidator.buildOrderingExplanation(numericSteps, '');

assert(numExplanation.includes('ascendente') || numExplanation.includes('descendente'),
    'Explicacion numerica menciona direccion (ascendente/descendente)');
console.log('  Explicacion numerica:', numExplanation);


// ─── Test 6: Verification steps always last (existing behavior preserved) ─────
console.log('\n═══ TEST 6: Verificacion siempre al final (regla existente) ═══');

const withVerify = [
    'Alinear los números',
    'Verificar el resultado',    // ← WRONG: verify should be last
    'Sumar columna por columna',
    'Llevar acarreos',
    'Escribir el resultado final'
];
const result6 = OrderingQuestionValidator.validateQuestion('Suma de números decimales:', withVerify);
const verifyIdx = (result6.items || withVerify).findIndex(s => /verificar/i.test(s));
const lastIdx6 = (result6.items || withVerify).length - 1;
assert(verifyIdx === lastIdx6, 'Verificacion movida al ultimo paso (pos ' + (verifyIdx+1) + ')');


// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`RESULTADOS: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));

process.exit(failed > 0 ? 1 : 0);
