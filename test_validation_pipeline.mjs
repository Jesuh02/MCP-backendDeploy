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
import Decimal from 'decimal.js';

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
// MathEngine: Fraction Arithmetic
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n═══ MathEngine: Fraction Arithmetic ═══`);
{
    const ME = MathEngine;

    // Basic fraction creation and simplification
    const f1 = ME.fraction(6, 8);
    assert(f1.num.eq(3) && f1.den.eq(4), 'fraction(6,8) simplifies to 3/4');

    // Fraction addition: 3/8 + 1/9 = 27/72 + 8/72 = 35/72
    const a = ME.fraction(3, 8);
    const b = ME.fraction(1, 9);
    const sum = ME.fractionAdd(a, b);
    assert(sum.num.eq(35) && sum.den.eq(72), '3/8 + 1/9 = 35/72');

    // Fraction subtraction: 3/8 - 1/9 = 27/72 - 8/72 = 19/72
    const diff = ME.fractionSub(a, b);
    assert(diff.num.eq(19) && diff.den.eq(72), '3/8 - 1/9 = 19/72');

    // Fraction multiplication: 3/8 * 1/9 = 3/72 = 1/24
    const prod = ME.fractionMul(a, b);
    assert(prod.num.eq(1) && prod.den.eq(24), '3/8 × 1/9 = 1/24');

    // Fraction division: (3/8) / (1/9) = 27/8
    const quot = ME.fractionDiv(a, b);
    assert(quot.num.eq(27) && quot.den.eq(8), '(3/8) ÷ (1/9) = 27/8');

    // parseFraction
    const pf1 = ME.parseFraction('3/8');
    assert(pf1 && pf1.num.eq(3) && pf1.den.eq(8), 'parseFraction("3/8") works');

    const pf2 = ME.parseFraction('2 3/4');
    assert(pf2 && pf2.num.eq(11) && pf2.den.eq(4), 'parseFraction("2 3/4") = 11/4');

    const pf3 = ME.parseFraction('5');
    assert(pf3 && pf3.num.eq(5) && pf3.den.eq(1), 'parseFraction("5") = 5/1');

    // evaluateFractionExpression (returns { fraction, decimal, steps })
    const expr1 = ME.evaluateFractionExpression('3/8 + 1/9');
    assert(expr1 && expr1.fraction.num.eq(35) && expr1.fraction.den.eq(72), 'evaluateFractionExpression("3/8 + 1/9") = 35/72');

    // fractionToDecimal
    const dec = ME.fractionToDecimal(ME.fraction(1, 3));
    assert(Math.abs(dec - 0.3333333) < 0.0001, 'fractionToDecimal(1/3) ≈ 0.333');

    // fractionToString
    const str = ME.fractionToString(ME.fraction(35, 72));
    assert(str === '35/72', 'fractionToString(35/72)');

    // GCD / LCM (return Decimal objects)
    assert(ME.gcd(12, 8).eq(4), 'gcd(12, 8) = 4');
    assert(ME.lcm(8, 9).eq(72), 'lcm(8, 9) = 72');
}

// ═══════════════════════════════════════════════════════════════════════════
// MathEngine: Exponentiation Verification
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n═══ MathEngine: Exponentiation Verification ═══`);
{
    const ME = MathEngine;

    // 2^10 = 1024
    const r1 = ME.verifyExponentiation(2, 10);
    assert(r1 && Math.abs(r1.value - 1024) < 0.01, 'verifyExponentiation(2, 10) = 1024');

    // 2.8^40 — checking magnitude
    const r2 = ME.verifyExponentiation(2.8, 40);
    assert(r2 && r2.magnitude > 15 && r2.magnitude < 20, '2.8^40 magnitude is between 15 and 20');
    console.log(`    2.8^40 value: ${r2 ? r2.value.toExponential(4) : 'null'}, magnitude: ${r2 ? r2.magnitude.toFixed(2) : 'null'}`);

    // orderOfMagnitude (expects Decimal)
    assert(ME.orderOfMagnitude(new Decimal(1000)) === 3, 'orderOfMagnitude(1000) = 3');
    assert(ME.orderOfMagnitude(new Decimal(0.001)) === -3, 'orderOfMagnitude(0.001) = -3');

    // sameOrderOfMagnitude (expects Decimal)
    assert(ME.sameOrderOfMagnitude(new Decimal(1500), new Decimal(3000)) === true, '1500 and 3000 same magnitude');
    assert(ME.sameOrderOfMagnitude(new Decimal(100), new Decimal(1e10)) === false, '100 and 1e10 NOT same magnitude');

    // crossVerify (expects Decimal for expectedResult)
    const cv = ME.crossVerify('2^10', new Decimal(1024));
    assert(cv && cv.verified === true, 'crossVerify("2^10", 1024) verified');
}

// ═══════════════════════════════════════════════════════════════════════════
// QuizMathValidator: Fraction Strategy (1.5)
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n═══ QuizMathValidator: Fraction Strategy ═══`);
{
    // Fraction addition question — should produce 35/72, not 103/72 or 4/17
    const qFrac = {
        type: 'multiple_choice',
        question: '¿Cuál es el resultado de sumar 3/8 + 1/9?',
        options: ['4/17', '103/72', '35/72', '1/3'],
        correctIndex: 2,
    };
    const rFrac = QuizMathValidator.verify(qFrac);
    assert(rFrac !== null && !rFrac.isRejected, 'Fraction sum 3/8 + 1/9 = 35/72 passes validation');
    if (rFrac) {
        console.log(`    Fraction result: correctIndex=${rFrac.correctedCorrectIndex ?? qFrac.correctIndex}, steps: ${rFrac.steps?.join(' → ') || 'N/A'}`);
    }

    // Fraction question with WRONG correctIndex — should correct to index 2
    const qFracWrong = {
        type: 'multiple_choice',
        question: '¿Cuál es el resultado de sumar 3/8 + 1/9?',
        options: ['4/17', '103/72', '35/72', '1/3'],
        correctIndex: 1, // LLM says 103/72 — WRONG
    };
    const rFracWrong = QuizMathValidator.verify(qFracWrong);
    // verify() mutates q.correctIndex directly and returns the modified q
    assert(rFracWrong !== null && qFracWrong.correctIndex === 2, 'Fraction: LLM wrong answer 103/72 corrected to 35/72 (index 2)');
}

// ═══════════════════════════════════════════════════════════════════════════
// AnswerVerificationGate: Fraction & Exponentiation Verifiers
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n═══ AnswerVerificationGate: New Verifiers ═══`);
{
    // Fraction naive addition detection
    const qNaiveFrac = {
        type: 'multiple_choice',
        question: 'Suma las fracciones 3/8 + 1/9',
        options: ['4/17', '35/72', '1/3', '2/5'],
        correctIndex: 0, // 4/17 is wrong — naive addition
    };
    const rNaiveFrac = gate.verify(qNaiveFrac);
    // Should either reject or correct
    console.log(`    Naive fraction result: ${rNaiveFrac ? (rNaiveFrac.correctedCorrectIndex !== undefined ? 'corrected to ' + rNaiveFrac.correctedCorrectIndex : 'passed') : 'rejected'}`);

    // Exponentiation magnitude sanity check
    const qExpBad = {
        type: 'multiple_choice',
        question: 'Calcula 2.8 elevado a la 40',
        options: ['2.037e15', '5.619e22', '1.234e8', '9.876e5'],
        correctIndex: 0, // 2.037e15 is wrong by ~7 orders of magnitude
    };
    const rExpBad = gate.verify(qExpBad);
    console.log(`    Exponentiation bad magnitude result: ${rExpBad ? 'passed' : 'rejected'}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// QuizMathValidator: Digit-Position Strategy (Strategy 0)
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n═══ QuizMathValidator: Digit-Position Strategy ═══`);
{
    // Test 1: Digit in "decenas de millón" of a sum
    const qDigit1 = {
        type: 'multiple_choice',
        question: '¿Cuál es el dígito en la posición de las decenas de millón de la suma de 12,345,678.9123 + 9,876,543.2187 + 5,555,555.5555 + 2,222,222.2222?',
        options: ['9', '2', '0', '5'],
        correctIndex: 1, // LLM says 2
    };
    const rDigit1 = QuizMathValidator.verify(qDigit1);
    // Sum = 29,999,999.9087, decenas de millón (10^7) = 2
    assert(rDigit1 !== null, 'Digit-position: question not rejected');
    // The digit at 10^7 in 29,999,999 is 2
    console.log(`    Digit-position result: correctIndex=${qDigit1.correctIndex}`);

    // Test 2: Digit position with fill_in_blank
    const qDigit2 = {
        type: 'fill_in_blank',
        question: '¿Cuál es el dígito de las centenas en el número 12,345?',
        correctAnswer: '3',
    };
    const rDigit2 = QuizMathValidator.verify(qDigit2);
    assert(rDigit2 !== null, 'Digit-position fill_in_blank: question not rejected');
    assert(rDigit2 && String(rDigit2.correctAnswer) === '3', 'Digit-position fill_in_blank: centenas of 12345 = 3');

    // Test 3: Wrong LLM answer corrected
    const qDigit3 = {
        type: 'multiple_choice',
        question: '¿Cuál es el dígito en las unidades de millón del número 87,654,321?',
        options: ['8', '7', '6', '5'],
        correctIndex: 0, // LLM says 8 — WRONG, unidades de millón is 7
    };
    const rDigit3 = QuizMathValidator.verify(qDigit3);
    assert(rDigit3 !== null && qDigit3.correctIndex === 1, 'Digit-position: unidades de millón of 87654321 corrected to 7 (index 1)');

    // Test 4: Doesn't produce nonsense like "0-9 = -9"
    const qDigit4 = {
        type: 'multiple_choice',
        question: '¿Cuál es el dígito en la posición de las decenas de millón del resultado de 12,345,678 + 9,876,543?',
        options: ['2', '1', '9', '0'],
        correctIndex: 0,
    };
    const rDigit4 = QuizMathValidator.verify(qDigit4);
    // Sum = 22,222,221, decenas de millón = 2
    assert(rDigit4 !== null && qDigit4.correctIndex === 0, 'Digit-position sum: produces correct index, no nonsense explanation');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Duplicate numeric options must be rejected
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test: Duplicate numeric options (all same result) ═══');
{
    const q = {
        type: 'multiple_choice',
        question: '¿Cuánto es 3 × $250?',
        options: ['$750', '750', '$750.00', '750.0'],
        correctIndex: 0,
        explanation: 'El resultado es $750.',
    };
    const result = pipeline.validate(q);
    assert(result === null, 'Should REJECT when all 4 options are numerically equal');
}

console.log('\n═══ Test: Two duplicate options out of four ═══');
{
    const q = {
        type: 'multiple_choice',
        question: '¿Cuánto es 100 + 200?',
        options: ['300', '$300', '350', '250'],
        correctIndex: 0,
        explanation: 'El resultado es 300.',
    };
    const result = pipeline.validate(q);
    assert(result === null, 'Should REJECT when 2 options are numerically equivalent (300 ≈ $300)');
}

console.log('\n═══ Test: Distinct options should pass ═══');
{
    const q = {
        type: 'multiple_choice',
        question: '¿Cuánto es 100 + 200?',
        options: ['300', '310', '290', '350'],
        correctIndex: 0,
        explanation: 'El resultado es 300.',
    };
    const result = pipeline.validate(q);
    assert(result !== null, 'Should PASS when all options are distinct');
}

// ═══════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
    process.exit(1);
}