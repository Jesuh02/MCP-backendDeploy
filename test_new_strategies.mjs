/**
 * Tests for new math validation strategies added to handle Q5-Q10 failures.
 * These are the specific question patterns from the production logs.
 */

import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';
import { ValidationPipeline } from './src/shared/math/ValidationPipeline.js';
import Decimal from 'decimal.js';

Decimal.set({ precision: 64 });

let passed = 0;
let failed = 0;

function test(label, actual, expected, tolerance = null) {
    let ok = false;
    if (actual === null && expected === null) {
        ok = true;
    } else if (actual === null || expected === null) {
        ok = false;
    } else if (tolerance) {
        ok = new Decimal(actual).minus(expected).abs().lte(tolerance);
    } else {
        ok = new Decimal(actual).eq(expected);
    }
    if (ok) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}: got ${actual}, expected ${expected}`);
        failed++;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Q5: Derivative extrema — minimum of cubic polynomial
// f(x) = x³ - 12x² + 45x - 10  →  min at x=5
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Q5: Derivative – Minimum of cubic polynomial ═══');
const q5Text = 'Para la función f(x) = x³ - 12x² + 45x - 10, determina el valor de x donde ocurre el mínimo local de la función.';
const q5Result = QuizMathValidator.computeExpectedAnswer(q5Text);
console.log('  Steps:', q5Result && q5Result.steps);
test('Q5: min at x=5', q5Result && q5Result.value && q5Result.value.toString(), '5');
// ═══════════════════════════════════════════════════════════════════════════
// Q6: Combined series — arithmetic + geometric with sigma notation
// S₁ = Σ_{i=1}^{200} (7i - 12)  (arithmetic via sigma)
// S₂ = Σ_{j=1}^{25} 4·(3.2)^{j-1}  (geometric via sigma)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Q6: Combined series — arithmetic + geometric sigma ═══');
const q6Text = 'Se define la serie aritmética S₁ = Σ_{i=1}^{200} (7i - 12) y la serie geométrica S₂ = Σ_{j=1}^{25} 4·(3.2)^{j-1}. Calcula S₁ + S₂ y redondea el resultado al entero más cercano.';
const q6Result = QuizMathValidator.computeExpectedAnswer(q6Text);
console.log('  Result:', q6Result && q6Result.value && q6Result.value.toExponential(4));
console.log('  Steps:', q6Result && q6Result.steps);

// S₁ = 7*200*201/2 - 12*200 = 140700 - 2400 = 138300
// S₂ = 4*(3.2^25 - 1)/(3.2 - 1) ≈ enormous
const expectedS1 = 138300;
// The point: Q6 result should be HUGE (>10^13), proving the options (148K-159K) are broken
if (q6Result && q6Result.value.gt(1e10)) {
    console.log('  ✅ Q6: Result is astronomical (>10^10), options would be rejected as broken');
    passed++;
} else {
    console.log('  ❌ Q6: Result should be astronomical but got:', q6Result && q6Result.value && q6Result.value.toString());
    failed++;
}

// Test that the pipeline rejects such a question with tiny options
const pipeline = ValidationPipeline.getInstance();
const q6Question = {
    question: q6Text,
    type: 'multiple_choice',
    options: ['148,250', '152,345', '155,680', '159,735'],
    correctIndex: 1,
};
const q6Validated = pipeline.validate(q6Question);
test('Q6: Pipeline REJECTS broken MC options', q6Validated, null);

// ═══════════════════════════════════════════════════════════════════════════
// Q8: Scientific notation sum — coefficient extraction
// A = 5.678912e8, B = 3.456789e7, C = 1.234567e6
// Sum ≈ 6.03694 × 10^8  → coefficient ≈ 6.0369
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Q8: Scientific notation sum – coefficient extraction ═══');
const q8Text = 'Suma los siguientes números en notación científica: A = 5.678912e8, B = 3.456789e7, C = 1.234567e6. Expresa el resultado como coeficiente en notación científica con 5 cifras significativas.';
const q8Result = QuizMathValidator.computeExpectedAnswer(q8Text);
console.log('  Result:', q8Result && q8Result.value && q8Result.value.toString());
console.log('  Steps:', q8Result && q8Result.steps);
// The coefficient should be between 1 and 10 (≈ 6.0369)
if (q8Result && q8Result.value.gte(1) && q8Result.value.lt(10)) {
    console.log('  ✅ Q8: Coefficient in [1,10)'); passed++;
} else {
    console.log('  ❌ Q8: Coefficient in [1,10) — got:', q8Result && q8Result.value && q8Result.value.toString()); failed++;
}
test('Q8: Coefficient ≈ 6.0369', q8Result && q8Result.value && q8Result.value.toString(), '6.0369', '0.001');

// Test that pipeline CORRECTS (or rejects) the wrong fill_in_blank answer
const q8FillBad = {
    question: q8Text,
    type: 'fill_in_blank',
    correctAnswer: '100000000',
};
const q8Validated = pipeline.validate(q8FillBad);
if (q8Validated === null) {
    console.log('  ✅ Q8: Pipeline REJECTED fill_in_blank with wrong coefficient'); passed++;
} else if (q8Validated.correctAnswer === '6.0369') {
    console.log('  ✅ Q8: Pipeline CORRECTED coefficient 100000000 → 6.0369'); passed++;
} else {
    console.log('  ❌ Q8: Pipeline kept wrong answer:', q8Validated.correctAnswer); failed++;
}

// ═══════════════════════════════════════════════════════════════════════════
// Q9: Derivative extrema — minimum of quartic polynomial
// f(x) = x⁴ - 24x³ + 216x² - 864x + 1296  →  min at x=6
// (this is (x-6)^4)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Q9: Derivative – Minimum of quartic polynomial ═══');
const q9Text = 'Si f(x) = x⁴ - 24x³ + 216x² - 864x + 1296, ¿cuál es el valor de x donde la función alcanza su mínimo local?';
const q9Result = QuizMathValidator.computeExpectedAnswer(q9Text);
console.log('  Result:', q9Result && q9Result.value && q9Result.value.toString());
console.log('  Steps:', q9Result && q9Result.steps);
test('Q9: min at x=6', q9Result && q9Result.value && q9Result.value.toString(), '6');

// ═══════════════════════════════════════════════════════════════════════════
// Q10: Sum then subtract — "resta la suma de los primeros cuatro números"
// 12,345,679 + 9,876,543 + 8,765,432 + 7,654,321 + 6,543,210
// Sum = 45,185,185
// Subtract sum of first 4: 45,185,185 - 38,641,975 = 6,543,210
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Q10: Sum then subtract first N numbers ═══');
const q10Text = 'Se suman cinco números grandes: 12,345,679 + 9,876,543 + 8,765,432 + 7,654,321 + 6,543,210. Luego, al resultado se le resta la suma de los primeros cuatro números. ¿Cuál es el resultado final?';
const q10Result = QuizMathValidator.computeExpectedAnswer(q10Text);
console.log('  Result:', q10Result && q10Result.value && q10Result.value.toString());
console.log('  Steps:', q10Result && q10Result.steps);
test('Q10: result = 6543210 (the 5th number)', q10Result && q10Result.value && q10Result.value.toString(), '6543210');

// Test pipeline rejects the wrong fill_in_blank answer "45185185"
const q10FillBad = {
    question: q10Text,
    type: 'fill_in_blank',
    correctAnswer: '45185185',
};
const q10Validated = pipeline.validate(q10FillBad);
// Pipeline should correct it to 6543210
if (q10Validated && q10Validated.correctAnswer === '6543210') {
    console.log('  ✅ Q10: Pipeline CORRECTED fill_in_blank to 6543210');
    passed++;
} else if (q10Validated) {
    console.log('  ❌ Q10: Pipeline kept answer:', q10Validated.correctAnswer, '(expected 6543210)');
    failed++;
} else {
    console.log('  ❌ Q10: Pipeline rejected the question (expected correction to 6543210)');
    failed++;
}

// ═══════════════════════════════════════════════════════════════════════════
// Additional: arithmetic series alone via sigma
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══ Extra: Arithmetic series alone ═══');
const arithText = 'Calcula la suma de la serie aritmética Σ_{i=1}^{200} (7i - 12).';
const arithResult = QuizMathValidator.computeExpectedAnswer(arithText);
console.log('  Result:', arithResult && arithResult.value && arithResult.value.toString());
// S = Σ(7i-12) from 1 to 200 = 7*200*201/2 - 12*200 = 140700 - 2400 = 138300
test('Arithmetic series sigma: 138300', arithResult && arithResult.value && arithResult.value.toString(), '138300');

console.log('\n═══ Extra: Geometric series alone via sigma ═══');
const geoText = 'Calcula la suma de la serie geométrica S₂ = Σ_{j=1}^{25} 4·(3.2)^{j-1}.';
const geoResult = QuizMathValidator.computeExpectedAnswer(geoText);
console.log('  Result:', geoResult && geoResult.value && geoResult.value.toExponential(4));
if (geoResult && geoResult.value.gt(1e10)) {
    console.log('  ✅ Geometric series via sigma is astronomical (correct)');
    passed++;
} else {
    console.log('  ❌ Geometric series via sigma should be huge');
    failed++;
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}`);

process.exit(failed > 0 ? 1 : 0);
