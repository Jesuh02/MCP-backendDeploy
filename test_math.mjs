import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';

// Test 1: Polynomial summation
var r1 = QuizMathValidator.computeExpectedAnswer('Evalua la sumatoria: \u03A3 (de i=1 a 30) de (5i\u00b2 - 3i + 7)');
console.log('Test 1 (Summation):', r1 ? r1.value.toString() : 'NULL');

// Test 2: Geometric series
var r2 = QuizMathValidator.computeExpectedAnswer('suma de los primeros 25 terminos de la serie geometrica: 4, 12, 36, 108');
console.log('Test 2 (Geometric):', r2 ? r2.value.toString() : 'NULL');

// Test 3: Simple arithmetic
var r3 = QuizMathValidator.computeExpectedAnswer('Calcula: 12345 + 9876 - 500');
console.log('Test 3 (Arithmetic):', r3 ? r3.value.toString() : 'NULL');

// Test 4: Combined summation + geometric
var text4 = 'Evalua la sumatoria: \u03A3 (de i=1 a 100) de (4i\u00b2 - 5i + 12). Luego, suma el resultado a la suma de los primeros 30 terminos de la serie geometrica: 8, 24, 72, 216';
var r4 = QuizMathValidator.computeExpectedAnswer(text4);
console.log('Test 4 (Combined):', r4 ? r4.value.toString() : 'NULL', '| fromFormula:', r4 ? r4.fromFormula : 'N/A');

// Test 5: verify() should NOT corrupt answers for formula problems
var q5 = {
    type: 'multiple_choice',
    question: 'Evalua la sumatoria: \u03A3 (de i=1 a 30) de (5i\u00b2 - 3i + 7). Suma a la serie geometrica: 4, 12, 36, 108 (25 terminos). Total?',
    options: ['A) 150', 'B) 211', 'C) 300', 'D) 400'],
    correctIndex: 1,
    explanation: 'La respuesta es 211'
};
var r5 = QuizMathValidator.verify(q5);
console.log('Test 5 (MC guard):', r5 === null ? 'REJECTED (correct!)' : 'Passed with index=' + r5.correctIndex);

// Test 6: Simple word problem should still work
var q6 = {
    type: 'fill_in_blank',
    question: 'Calcula el total: $1500 + $2300 + $750',
    correctAnswer: '4500',
    explanation: 'Suma total'
};
var r6 = QuizMathValidator.verify(q6);
console.log('Test 6 (Word problem):', r6 ? r6.correctAnswer : 'NULL');
// Test 7: Rounding to integer
var text7 = 'Evalua la sumatoria: \u03A3 (de i=1 a 30) de (5i\u00b2 - 3i + 7) (Redondea a entero)';
var r7 = QuizMathValidator.computeExpectedAnswer(text7);
if (r7) {
    var rounded = QuizMathValidator._applyDecimals(r7.value, text7);
    console.log('Test 7 (Rounding):', rounded.toString());
}

console.log('\n--- All tests completed ---');