import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';

// Test 1: Polynomial summation
var r1 = QuizMathValidator.computeExpectedAnswer('Evalua la sumatoria: \u03A3 (de i=1 a 30) de (5i\u00b2 - 3i + 7)');
console.log('Test 1 (Summation):', r1 ? r1.value.toString() : 'NULL', r1 && r1.value.toString() === '46090' ? '\u2705' : '\u274C expected 46090');

// Test 2: Geometric series (explicit keyword)
var r2 = QuizMathValidator.computeExpectedAnswer('suma de los primeros 25 terminos de la serie geometrica: 4, 12, 36, 108');
console.log('Test 2 (Geometric explicit):', r2 ? r2.value.toString() : 'NULL', r2 && r2.value.toString() === '1694577218884' ? '\u2705' : '\u274C expected 1694577218884');

// Test 2b: Geometric series (implicit - no keyword, just sequence)
var r2b = QuizMathValidator.computeExpectedAnswer('Calcula la suma de los primeros 25 terminos de la secuencia: 4, 12, 36, 108');
console.log('Test 2b (Geometric implicit):', r2b ? r2b.value.toString() : 'NULL', r2b && r2b.value.toString() === '1694577218884' ? '\u2705' : '\u274C expected 1694577218884');

// Test 3: Simple arithmetic
var r3 = QuizMathValidator.computeExpectedAnswer('Calcula: 12345 + 9876 - 500');
console.log('Test 3 (Arithmetic):', r3 ? r3.value.toString() : 'NULL', r3 && r3.value.toString() === '21721' ? '\u2705' : '\u274C expected 21721');

// Test 4: Combined summation + geometric
var text4 = 'Evalua la sumatoria: \u03A3 (de i=1 a 100) de (4i\u00b2 - 5i + 12). Luego, suma el resultado a la suma de los primeros 30 terminos de la serie geometrica: 8, 24, 72, 216';
var r4 = QuizMathValidator.computeExpectedAnswer(text4);
console.log('Test 4 (Combined):', r4 ? r4.value.toString() : 'NULL', '| fromFormula:', r4 ? r4.fromFormula : 'N/A');

// Test 5: verify() MUST reject a broken question (geometric series sum >> options)
var q5 = {
    type: 'multiple_choice',
    question: 'Evalua la sumatoria: \u03A3 (de i=1 a 30) de (5i\u00b2 - 3i + 7). Suma a la serie geometrica: 4, 12, 36, 108 (25 terminos). Total?',
    options: ['A) 150', 'B) 211', 'C) 300', 'D) 400'],
    correctIndex: 1,
    explanation: 'La respuesta es 211'
};
var r5 = QuizMathValidator.verify(q5);
console.log('Test 5 (MC broken question guard):', r5 === null ? 'REJECTED \u2705' : 'PASSED (bad!) index=' + r5?.correctIndex);

// Test 5b: verify() MUST reject implicit geometric broken question
var q5b = {
    type: 'multiple_choice',
    question: 'Calcula la suma de los primeros 25 terminos de la secuencia 4, 12, 36, 108. \u00bfCu\u00e1l es el total?',
    options: ['A) 180', 'B) 211', 'C) 250', 'D) 300'],
    correctIndex: 1,
    explanation: 'El resultado es 211'
};
var r5b = QuizMathValidator.verify(q5b);
console.log('Test 5b (Implicit geometric broken):', r5b === null ? 'REJECTED \u2705' : 'PASSED (bad!) index=' + r5b?.correctIndex);

// Test 6: fill_in_blank should auto-correct wrong LLM answer
var q6 = {
    type: 'fill_in_blank',
    question: 'Calcula el total: $1500 + $2300 + $750',
    correctAnswer: '4500',
    explanation: 'Suma total'
};
var r6 = QuizMathValidator.verify(q6);
console.log('Test 6 (fill_in_blank auto-correct):', r6 ? r6.correctAnswer : 'NULL', r6 && r6.correctAnswer === '4550' ? '\u2705' : '\u274C expected 4550');

// Test 7: Rounding
var text7 = 'Evalua la sumatoria: \u03A3 (de i=1 a 30) de (5i\u00b2 - 3i + 7) (Redondea a entero)';
var r7 = QuizMathValidator.computeExpectedAnswer(text7);
if (r7) {
    var rounded = QuizMathValidator._applyDecimals(r7.value, text7);
    console.log('Test 7 (Rounding):', rounded.toString(), rounded.toString() === '46090' ? '\u2705' : '\u274C expected 46090');
}

// Test 8: MC with correct answer should be ACCEPTED and corrected if wrong index
var q8 = {
    type: 'multiple_choice',
    question: 'Calcula: 150 + 75 - 25',
    options: ['A) 180', 'B) 200', 'C) 210', 'D) 250'],
    correctIndex: 3, // Wrong! Correct answer is 200 (index 1)
    explanation: 'El resultado es 200'
};
var r8 = QuizMathValidator.verify(q8);
console.log('Test 8 (MC index correction):', r8 ? 'ACCEPTED index=' + r8.correctIndex + (r8.correctIndex === 1 ? ' \u2705' : ' \u274C expected 1') : 'REJECTED \u274C');

console.log('\n--- All tests completed ---');
