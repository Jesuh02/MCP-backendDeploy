/**
 * Reproduction test for the 4-operand omission bug.
 * The system sums only 3 of 4 numbers in certain formats.
 */
import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';
import Decimal from 'decimal.js';
Decimal.set({ precision: 64 });

let passed = 0, failed = 0;
function test(label, actual, expected) {
    if (actual === expected) { console.log(`  ✅ ${label}: ${actual}`); passed++; }
    else { console.log(`  ❌ ${label}: got ${actual}, expected ${expected}`); failed++; }
}

// The 4 numbers from the user's bug report
// A = 12,345,678.9876
// B = 9,876,543.2109
// C = 5,555,555.5555
// D = 2,222,222.2222
// Correct sum = 29,999,999.9762
// Bug: system summed only A+B+C = 27,777,777.754 (missed D)

console.log('\n═══ Scenario 1: Explicit + operators ═══');
var t1 = QuizMathValidator.computeExpectedAnswer(
    'Calcula la suma de 12,345,678.9876 + 9,876,543.2109 + 5,555,555.5555 + 2,222,222.2222'
);
console.log('  Steps:', t1?.steps);
test('S1: Sum all 4', t1?.value?.toString(), '29999999.9762');

console.log('\n═══ Scenario 2: Labeled values (no + operators) ═══');
var t2 = QuizMathValidator.computeExpectedAnswer(
    'Calcula la suma de los siguientes valores: A = 12,345,678.9876, B = 9,876,543.2109, C = 5,555,555.5555, D = 2,222,222.2222'
);
console.log('  Steps:', t2?.steps);
test('S2: Sum all 4 labeled', t2?.value?.toString(), '29999999.9762');

console.log('\n═══ Scenario 3: Digit-position problem (labeled) ═══');
var t3 = QuizMathValidator.computeExpectedAnswer(
    '¿Cuál es el dígito en la posición de las decenas de millón de la suma de los siguientes valores redondeada a 3 decimales? A = 12,345,678.9876, B = 9,876,543.2109, C = 5,555,555.5555, D = 2,222,222.2222'
);
console.log('  Steps:', t3?.steps);
// Sum = 29,999,999.9762 → int part = 29999999 → decenas de millón = 2
test('S3: Digit at 10^7', t3?.value?.toString(), '2');

console.log('\n═══ Scenario 4: Digit-position problem (+ operators) ═══');
var t4 = QuizMathValidator.computeExpectedAnswer(
    '¿Cuál es el dígito en la posición de las decenas de millón de la suma 12,345,678.9876 + 9,876,543.2109 + 5,555,555.5555 + 2,222,222.2222 redondeada a 3 decimales?'
);
console.log('  Steps:', t4?.steps);
test('S4: Digit at 10^7 with +', t4?.value?.toString(), '2');

console.log('\n═══ Scenario 5: verify() MC - digit position ═══');
var q5 = {
    type: 'multiple_choice',
    question: '¿Cuál es el dígito en la posición de las decenas de millón de la suma de 12,345,678.9876 + 9,876,543.2109 + 5,555,555.5555 + 2,222,222.2222 redondeada a 3 decimales?',
    options: ['A) 2', 'B) 7', 'C) 9', 'D) 3'],
    correctIndex: 1,  // LLM says 7 (wrong - based on 3 numbers)
    explanation: 'La suma es 27,777,777.754, el dígito en decenas de millón es 7'
};
var r5 = QuizMathValidator.verify(q5);
console.log('  Result:', r5 ? 'index=' + r5.correctIndex : 'REJECTED');
test('S5: MC corrected to index 0 (digit=2)', r5?.correctIndex?.toString(), '0');

console.log('\n═══ Scenario 6: verify() fill-in-blank - digit position ═══');
var q6 = {
    type: 'fill_in_blank',
    question: '¿Cuál es el dígito en la posición de las decenas de millón de la suma de 12,345,678.9876 + 9,876,543.2109 + 5,555,555.5555 + 2,222,222.2222 redondeada a 3 decimales?',
    correctAnswer: '7',  // LLM says 7 (wrong)
    explanation: 'La suma es 27,777,777.754, el dígito en decenas de millón es 7'
};
var r6 = QuizMathValidator.verify(q6);
test('S6: Fill corrected to 2', r6?.correctAnswer, '2');

console.log('\n═══ Scenario 7: Simple sum (no digit position) ═══');
var t7 = QuizMathValidator.computeExpectedAnswer(
    'Calcula el total: $12,345,678.9876 + $9,876,543.2109 + $5,555,555.5555 + $2,222,222.2222'
);
console.log('  Steps:', t7?.steps);
test('S7: Currency sum all 4', t7?.value?.toString(), '29999999.9762');

console.log('\n═══ Scenario 8: Sum with "y" connector ═══');
var t8 = QuizMathValidator.computeExpectedAnswer(
    'Calcula la suma total de los valores 12,345,678.9876, 9,876,543.2109, 5,555,555.5555 y 2,222,222.2222'
);
console.log('  Steps:', t8?.steps);
test('S8: Sum with y connector', t8?.value?.toString(), '29999999.9762');

console.log('\n═══ Scenario 9: Labeled with Q prefix ═══');
var t9 = QuizMathValidator.computeExpectedAnswer(
    'Una empresa reporta valores trimestrales: Q1=$12,345,678.9876, Q2=$9,876,543.2109, Q3=$5,555,555.5555, Q4=$2,222,222.2222. ¿Cuánto es el monto total?'
);
console.log('  Steps:', t9?.steps);
test('S9: Q-labeled sum', t9?.value?.toString(), '29999999.9762');

console.log('\n═══ Scenario 10: Ordering question validation ═══');
// Basic ordering test for math context
import { OrderingQuestionValidator } from './src/shared/math/OrderingQuestionValidator.js';
var oq = 'Ordena los pasos para resolver una ecuación de segundo grado';
var oi = [
    'Aplicar la fórmula general',
    'Identificar a, b y c',
    'Calcular el discriminante',
    'Simplificar el resultado'
];
var or = OrderingQuestionValidator.validateQuestion(oq, oi);
var orItems = or.items || oi;
var idIdx = orItems.findIndex(s => /identificar/i.test(s));
var discIdx = orItems.findIndex(s => /discriminante/i.test(s));
var formIdx = orItems.findIndex(s => /fórmula/i.test(s));
console.log('  Order:', orItems.map(s => s.substring(0, 25)));
test('S10: Identificar before Discriminante', idIdx < discIdx ? 'yes' : 'no', 'yes');

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
