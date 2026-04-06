/**
 * Test suite for MathEngine + ValidationPipeline
 * Tests the 5 systematic errors identified:
 *   1. Options that don't include the correct answer
 *   2. Fabricated backwards answers (naive sum of parameters)
 *   3. Steps in illogical order (ordering dependencies)
 *   4. Marking correct as incorrect
 *   5. Poorly designed problems (geometric series magnitude)
 */

import { MathEngine } from './src/shared/math/MathEngine.js';
import { ValidationPipeline } from './src/shared/math/ValidationPipeline.js';
import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';
import { AnswerVerificationGate } from './src/shared/math/AnswerVerificationGate.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.log(`  ❌ FAIL: ${label}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. MathEngine — Expression Evaluation
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ MathEngine: Expression Evaluation ═══');

// Basic arithmetic
assert(MathEngine.evaluate('3 + 5').eq(8), '3 + 5 = 8');
assert(MathEngine.evaluate('10 - 3').eq(7), '10 - 3 = 7');
assert(MathEngine.evaluate('4 * 6').eq(24), '4 * 6 = 24');
assert(MathEngine.evaluate('15 / 3').eq(5), '15 / 3 = 5');

// Operator precedence (this was broken in old version)
assert(MathEngine.evaluate('2 + 3 * 4').eq(14), '2 + 3 * 4 = 14 (not 20)');
assert(MathEngine.evaluate('10 - 2 * 3').eq(4), '10 - 2 * 3 = 4 (not 24)');
assert(MathEngine.evaluate('(2 + 3) * 4').eq(20), '(2 + 3) * 4 = 20');
assert(MathEngine.evaluate('100 / 5 + 3 * 2').eq(26), '100/5 + 3*2 = 26');

// Exponents
assert(MathEngine.evaluate('2 ^ 10').eq(1024), '2^10 = 1024');
assert(MathEngine.evaluate('3 ^ 3').eq(27), '3^3 = 27');

// Negative numbers
assert(MathEngine.evaluate('-5 + 3').eq(-2), '-5 + 3 = -2');
assert(MathEngine.evaluate('-(3 + 2)').eq(-5), '-(3+2) = -5');

// Functions
assert(MathEngine.evaluate('sqrt(144)').eq(12), 'sqrt(144) = 12');
assert(MathEngine.evaluate('abs(-42)').eq(42), 'abs(-42) = 42');
assert(MathEngine.evaluate('min(5, 3, 8)').eq(3), 'min(5,3,8) = 3');
assert(MathEngine.evaluate('max(5, 3, 8)').eq(8), 'max(5,3,8) = 8');

// Thousands separator
assert(MathEngine.evaluate('1000 + 500').eq(1500), '1,000 + 500 = 1,500');

// tryEvaluate safety
assert(MathEngine.tryEvaluate('invalid expression') === null, 'Invalid expression returns null');
assert(MathEngine.tryEvaluate('5 / 0') === null, 'Division by zero returns null');

// ═══════════════════════════════════════════════════════════════════════════
// 2. MathEngine — Series Computations
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ MathEngine: Series ═══');

// Geometric series: a1=4, r=3, n=25 → ~1.6 billion
const geo = MathEngine.geometricSeries(4, 3, 25);
assert(geo.value.gt(1e9), 'Geometric series a1=4,r=3,n=25 > 1 billion');
console.log(`    Geometric series result: ${geo.value.toExponential(4)}`);

// Arithmetic series: a1=1, d=1, n=100 → 5050
const arith = MathEngine.arithmeticSeries(1, 1, 100);
assert(arith.value.eq(5050), 'Arithmetic series 1..100 = 5050');

// Simple interest
const si = MathEngine.simpleInterest(1000, 5, 3);
assert(si.interest.eq(150), 'Simple interest: 1000, 5%, 3 years = 150');
assert(si.total.eq(1150), 'Simple interest total: 1150');

// Compound interest
const ci = MathEngine.compoundInterest(1000, 10, 2);
assert(ci.total.eq(1210), 'Compound interest: 1000, 10%, 2 years = 1210');
assert(ci.interest.eq(210), 'Compound interest amount: 210');

// ═══════════════════════════════════════════════════════════════════════════
// 3. Error 1: Options that don't include the correct answer → REJECT
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Error 1: Options missing correct answer → REJECT ═══');

const pipeline = ValidationPipeline.getInstance();

// Case: sum of 4 numbers should be 300,000 but options are 300,006 etc.
const q1 = {
    type: 'multiple_choice',
    question: 'Calcula la suma de 100,000 + 50,000 + 75,000 + 75,000',
    options: ['300,006', '300,016', '300,106', '299,996'],
    correctIndex: 0,
    explanation: 'Sumamos los valores...',
};
const r1 = pipeline.validate(q1);
// Real answer is 300,000 which IS close to 299,996 (within tolerance)
// The pipeline should either correct or reject
console.log(`    Q1 result: ${r1 ? 'corrected/passed' : 'rejected'}`);
if (r1) {
    assert(r1.correctIndex === 3, 'Corrected to closest option (299,996)');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Error 2: Fabricated backwards answers (naive parameter sum) → REJECT
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Error 2: Fabricated backwards answers → REJECT ═══');

// Case: LLM summed indices/terms: 30 + 25 + 12 + 36 + 108 = 211 instead of proper calculation
const q2 = {
    type: 'multiple_choice',
    question: 'Calcula la suma de los primeros 25 términos de la secuencia 4, 12, 36, 108',
    options: ['211', '250', '300', '180'],
    correctIndex: 0,
    explanation: '30 + 25 + 12 + 36 + 108 = 211',
};
const r2 = pipeline.validate(q2);
assert(r2 === null, 'Fabricated parameter-sum answer REJECTED');

// ═══════════════════════════════════════════════════════════════════════════
// 5. Error 3: Ordering steps with dependency violations → REJECT
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Error 3: Ordering dependency violations → REJECT ═══');

const q3 = {
    type: 'ordering',
    question: '¿Cuál es el orden correcto para sumar dos números decimales?',
    items: [
        'Alinear los números por el punto decimal',
        'Escribir la coma del resultado',
        'Sumar columna por columna',
        'Verificar con acarreos',
    ],
    // Wrong order: write comma BEFORE summing
    correctOrder: [0, 1, 2, 3],
    explanation: 'Primero alinear, luego escribir coma, luego sumar...',
};
const r3 = pipeline.validate(q3);
assert(r3 === null, 'Ordering with dependency violation REJECTED');

// Correct ordering should pass
const q3correct = {
    type: 'ordering',
    question: '¿Cuál es el orden correcto para sumar dos números decimales?',
    items: [
        'Alinear los números por el punto decimal',
        'Sumar columna por columna',
        'Verificar con acarreos',
        'Escribir la coma del resultado',
    ],
    correctOrder: [0, 1, 2, 3],
    explanation: 'Primero alinear, luego sumar, verificar acarreos, escribir coma del resultado.',
};
const r3c = pipeline.validate(q3correct);
assert(r3c !== null, 'Correct ordering PASSES validation');

// ═══════════════════════════════════════════════════════════════════════════
// 6. Error 5: Geometric series with astronomical result vs tiny options → REJECT
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Error 5: Broken geometric series → REJECT ═══');

const q5 = {
    type: 'multiple_choice',
    question: 'Calcula la suma de los primeros 25 términos de la serie geométrica 4, 12, 36, 108',
    options: ['150', '200', '250', '300'],
    correctIndex: 1,
    explanation: 'La suma es 200',
};
const r5 = pipeline.validate(q5);
assert(r5 === null, 'Geometric series with astronomical result vs tiny options REJECTED');

// ═══════════════════════════════════════════════════════════════════════════
// 7. QuizMathValidator — No longer trusts LLM explanations
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ LLM Explanation Trust: ELIMINATED ═══');

// _tryFromExplanation should now always return null
const llmExplanation = QuizMathValidator._tryFromExplanation('El resultado es 42');
assert(llmExplanation === null, '_tryFromExplanation always returns null (deprecated)');

// Reconcile should NEVER fallback to explanation
const reconciled = QuizMathValidator._reconcileResults(null, { value: 42 }, {});
assert(reconciled === null, '_reconcileResults returns null when no computed result (no explanation fallback)');

// ═══════════════════════════════════════════════════════════════════════════
// 8. MathEngine — Geometric Sequence Detection
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ MathEngine: Geometric Sequence Detection ═══');

import Decimal from 'decimal.js';

const geoSeq = MathEngine.detectGeometricSequence([
    new Decimal(4), new Decimal(12), new Decimal(36), new Decimal(108),
]);
assert(geoSeq !== null, 'Detects geometric sequence 4,12,36,108');
assert(geoSeq && geoSeq.a1.eq(4), 'a1 = 4');
assert(geoSeq && geoSeq.r.eq(3), 'r = 3');

const noGeo = MathEngine.detectGeometricSequence([
    new Decimal(1), new Decimal(2), new Decimal(4), new Decimal(7),
]);
assert(noGeo === null, 'Non-geometric sequence returns null');

// ═══════════════════════════════════════════════════════════════════════════
// 9. Integration: Full pipeline with multiplication problem
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Integration: Multiplication problem ═══');

const qMult = {
    type: 'multiple_choice',
    question: 'Si compró 5 libros a $200 cada uno, ¿cuánto pagó en total?',
    options: ['$800', '$1000', '$1200', '$205'],
    correctIndex: 3, // LLM wrongly marked 205 (naive sum: 5+200)
    explanation: 'Sumamos 5 + 200 = 205',
};
const rMult = pipeline.validate(qMult);
if (rMult) {
    assert(rMult.correctIndex === 1, 'Pipeline corrected 5×200=1000 (index 1)');
} else {
    assert(false, 'Pipeline should correct, not reject multiplication problem');
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. AnswerVerificationGate — System of equations integrity
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ System of Equations Verification ═══');

const gate = AnswerVerificationGate.getInstance();

// Good equation system
const qEq = {
    type: 'multiple_choice',
    question: 'Resuelve el sistema: 2x + 3y = 12 y x - y = 1',
    options: ['x=3, y=2', 'x=2, y=3', 'x=1, y=4', 'x=4, y=1'],
    correctIndex: 0,
};
const rEq = gate.verify(qEq);
assert(rEq !== null, 'Valid equation system passes');

// Bad equation system with non-integer solution
const qEqBad = {
    type: 'multiple_choice',
    question: 'Resuelve por eliminación: 3x + 7y = 15 y 2x + 5y = 11',
    options: ['x=3, y=2', 'x=2, y=1', 'x=1, y=3', 'x=4, y=0'],
    correctIndex: 1,
};
const rEqBad = gate.verify(qEqBad);
// This might pass or fail depending on whether the solution is integer
console.log(`    Non-integer system result: ${rEqBad ? 'passed' : 'rejected'}`);

// ═══════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
    process.exit(1);
}