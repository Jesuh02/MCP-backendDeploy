import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';

// ═══════════════════════════════════════════════════════════════════════════
// EXISTING TESTS (regression — must still pass)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// NEW TESTS: Operation Detection (the core bug fix)
// These test that the validator UNDERSTANDS the operation, not just the numbers
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== NEW: Multiplication / Rate Detection ===');

// Test 9: Area — "base 5, altura 3 → 5×3 = 15" (NOT 5+3=8)
var r9 = QuizMathValidator.computeExpectedAnswer('Calcula el \u00e1rea de un rect\u00e1ngulo con base 5 y altura 3');
console.log('Test 9  (Area 5\u00d73):', r9 ? r9.value.toString() : 'NULL', r9 && r9.value.toString() === '15' ? '\u2705' : '\u274C expected 15 NOT 8');

// Test 10: Qty × Price — "5 artículos a $200" → 5×200=1000 (NOT 5+200=205)
var r10 = QuizMathValidator.computeExpectedAnswer('Una tienda vende 5 art\u00edculos a $200 cada uno. \u00bfCu\u00e1l es el total?');
console.log('Test 10 (Qty\u00d7Price):', r10 ? r10.value.toString() : 'NULL', r10 && r10.value.toString() === '1000' ? '\u2705' : '\u274C expected 1000 NOT 205');

// Test 11: Worker × Salary — "12 trabajadores ganan $500 al mes" → 12×500=6000
var r11 = QuizMathValidator.computeExpectedAnswer('Si 12 trabajadores ganan $500 al mes, \u00bfcu\u00e1nto es el gasto total mensual?');
console.log('Test 11 (Worker\u00d7Salary):', r11 ? r11.value.toString() : 'NULL', r11 && r11.value.toString() === '6000' ? '\u2705' : '\u274C expected 6000');

// Test 12: Rate problem — "200 GB a $0.05 por GB" → 200×0.05=10
var r12 = QuizMathValidator.computeExpectedAnswer('Un servicio de almacenamiento cobra $0.05 por GB. Si se usan 200 GB, \u00bfcu\u00e1nto se paga?');
console.log('Test 12 (Rate):', r12 ? r12.value.toString() : 'NULL', r12 && r12.value.toString() === '10' ? '\u2705' : '\u274C expected 10');

// Test 13: Dimensions — "terreno 15m x 8m" → 15×8=120
var r13 = QuizMathValidator.computeExpectedAnswer('Un terreno rectangular mide 15 metros por 8 metros. \u00bfCu\u00e1l es su \u00e1rea?');
console.log('Test 13 (Terreno):', r13 ? r13.value.toString() : 'NULL', r13 && r13.value.toString() === '120' ? '\u2705' : '\u274C expected 120');

// Test 14: "compró 15 libros de $50" → 15×50=750 (NOT 15+50=65)
var r14 = QuizMathValidator.computeExpectedAnswer('Mar\u00eda compr\u00f3 15 libros de $50 cada uno. \u00bfCu\u00e1nto pag\u00f3 en total?');
console.log('Test 14 (Compr\u00f3):', r14 ? r14.value.toString() : 'NULL', r14 && r14.value.toString() === '750' ? '\u2705' : '\u274C expected 750');

console.log('\n=== NEW: Percentage Detection ===');

// Test 15: "15% de 200" → 30 (NOT 15+200=215)
var r15 = QuizMathValidator.computeExpectedAnswer('Calcula el 15% de 200');
console.log('Test 15 (15% de 200):', r15 ? r15.value.toString() : 'NULL', r15 && r15.value.toString() === '30' ? '\u2705' : '\u274C expected 30');

// Test 16: Discount — "$1000 con descuento del 20%" → 800
var r16 = QuizMathValidator.computeExpectedAnswer('\u00bfCu\u00e1l es el precio final de un producto de $1000 con descuento del 20%?');
console.log('Test 16 (Discount 20%):', r16 ? r16.value.toString() : 'NULL', r16 && r16.value.toString() === '800' ? '\u2705' : '\u274C expected 800');

// Test 17: Tax — "$1000 con IVA del 16%" → 1160
var r17 = QuizMathValidator.computeExpectedAnswer('\u00bfCu\u00e1l es el monto total de un producto de $1000 con IVA del 16%?');
console.log('Test 17 (IVA 16%):', r17 ? r17.value.toString() : 'NULL', r17 && r17.value.toString() === '1160' ? '\u2705' : '\u274C expected 1160');

console.log('\n=== NEW: Division Detection ===');

// Test 18: "repartir $1200 entre 4 personas" → 300
var r18 = QuizMathValidator.computeExpectedAnswer('Si se reparten $1200 entre 4 personas, \u00bfcu\u00e1nto recibe cada una?');
console.log('Test 18 (Division):', r18 ? r18.value.toString() : 'NULL', r18 && r18.value.toString() === '300' ? '\u2705' : '\u274C expected 300');

// Test 19: "dividir 500 entre 5" → 100
var r19 = QuizMathValidator.computeExpectedAnswer('Dividir 500 entre 5');
console.log('Test 19 (Dividir):', r19 ? r19.value.toString() : 'NULL', r19 && r19.value.toString() === '100' ? '\u2705' : '\u274C expected 100');

console.log('\n=== NEW: Average Detection ===');

// Test 20: "promedio de 10, 20, 30" → 20
var r20 = QuizMathValidator.computeExpectedAnswer('Calcula el promedio de 10, 20, 30');
console.log('Test 20 (Average):', r20 ? r20.value.toString() : 'NULL', r20 && r20.value.toString() === '20' ? '\u2705' : '\u274C expected 20');

// Test 21: "media de 85, 90, 78, 95" → 87
var r21 = QuizMathValidator.computeExpectedAnswer('\u00bfCu\u00e1l es la media de 85, 90, 78 y 95?');
console.log('Test 21 (Media):', r21 ? r21.value.toString() : 'NULL', r21 && r21.value.toString() === '87' ? '\u2705' : '\u274C expected 87');

console.log('\n=== NEW: Compound / Multi-step Problems ===');

// Test 22: "3 libros a $50 y 5 cuadernos a $20" → 3×50 + 5×20 = 250
var r22 = QuizMathValidator.computeExpectedAnswer('Compr\u00f3 3 libros a $50 y 5 cuadernos a $20. \u00bfCu\u00e1nto pag\u00f3 en total?');
console.log('Test 22 (Compound):', r22 ? r22.value.toString() : 'NULL', r22 && r22.value.toString() === '250' ? '\u2705' : '\u274C expected 250');

console.log('\n=== NEW: Interest Problems ===');

// Test 23: Simple interest — capital $10000, tasa 5%, tiempo 3 años → I = 1500
var r23 = QuizMathValidator.computeExpectedAnswer('Calcula el inter\u00e9s simple de un capital de $10000 con tasa de 5% durante un tiempo de 3 a\u00f1os');
console.log('Test 23 (Simple Interest):', r23 ? r23.value.toString() : 'NULL', r23 && r23.value.toString() === '1500' ? '\u2705' : '\u274C expected 1500');

console.log('\n=== NEW: Explicit Sum (Conservative) ===');

// Test 24: Explicit sum with $ — "$1500 + $2300 + $750" → 4550
var r24 = QuizMathValidator.computeExpectedAnswer('Calcula el total: $1500 + $2300 + $750');
console.log('Test 24 (Explicit $ sum):', r24 ? r24.value.toString() : 'NULL', r24 && r24.value.toString() === '4550' ? '\u2705' : '\u274C expected 4550');

// Test 25: Gasto total with labeled items → should sum
var r25 = QuizMathValidator.computeExpectedAnswer('Los gastos mensuales son: alquiler $500, comida $300, transporte $100. \u00bfCu\u00e1l es el gasto total?');
console.log('Test 25 (Gasto total):', r25 ? r25.value.toString() : 'NULL', r25 && r25.value.toString() === '900' ? '\u2705' : '\u274C expected 900');

console.log('\n=== NEW: Protection Against Blind Summation ===');

// Test 26: MUST NOT blindly sum parameters
// "rectángulo de 5×3 calcula el área" must return 15, NOT 8
var q26 = {
    type: 'multiple_choice',
    question: 'Un rect\u00e1ngulo tiene base de 5 cm y altura de 3 cm. \u00bfCu\u00e1l es su \u00e1rea?',
    options: ['A) 8 cm\u00b2', 'B) 15 cm\u00b2', 'C) 16 cm\u00b2', 'D) 30 cm\u00b2'],
    correctIndex: 0, // Wrong! LLM said 8 (sum) but correct is 15 (product) → index 1
    explanation: 'El \u00e1rea es base por altura = 5 \u00d7 3 = 15'
};
var r26 = QuizMathValidator.verify(q26);
console.log('Test 26 (Area MC fix):', r26 ? 'index=' + r26.correctIndex + (r26.correctIndex === 1 ? ' \u2705' : ' \u274C expected 1') : 'REJECTED \u274C');

// Test 27: Perimeter — 2×(5+3) = 16
var r27 = QuizMathValidator.computeExpectedAnswer('Calcula el per\u00edmetro de un rect\u00e1ngulo con base 5 y altura 3');
console.log('Test 27 (Perimeter):', r27 ? r27.value.toString() : 'NULL', r27 && r27.value.toString() === '16' ? '\u2705' : '\u274C expected 16');

// Test 28: Volume — 4×3×5 = 60
var r28 = QuizMathValidator.computeExpectedAnswer('Calcula el volumen de un prisma rectangular de 4 x 3 x 5 metros');
console.log('Test 28 (Volume):', r28 ? r28.value.toString() : 'NULL', r28 && r28.value.toString() === '60' ? '\u2705' : '\u274C expected 60');

console.log('\n--- All tests completed ---');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX TESTS: Three reported validation failures
// ═══════════════════════════════════════════════════════════════════════════

import { OrderingQuestionValidator } from './src/shared/math/OrderingQuestionValidator.js';

console.log('\n=== BUG FIX 1: Ordering - Verificar dimensiones ANTES de calcular ===');

// Test B1: "Verificar dimensiones" must come BEFORE "Calcular la suma"
var oq1 = 'Ordena los pasos para sumar dos matrices de 3x3';
var oi1 = ['Calcular la suma elemento por elemento', 'Escribir la matriz resultado', 'Verificar dimensiones de las matrices'];
var or1 = OrderingQuestionValidator.validateQuestion(oq1, oi1);
var or1Items = or1.items || oi1;
var vdIdx = or1Items.findIndex(function(s) { return /verificar/i.test(s); });
var csIdx = or1Items.findIndex(function(s) { return /calcular/i.test(s); });
console.log('Test B1 (Ordering):', vdIdx < csIdx ? '✅' : '❌ Verificar dimensiones debe ir ANTES de Calcular la suma',
    '| order:', or1Items.map(function(s) { return s.substring(0, 30); }));

// Test B1b: "Verificar que las dimensiones coincidan" (phrasal variant)
var oq1b = 'Pasos para sumar matrices';
var oi1b = ['Sumar los elementos correspondientes', 'Verificar que las dimensiones coincidan', 'Anotar el resultado'];
var or1b = OrderingQuestionValidator.validateQuestion(oq1b, oi1b);
var or1bItems = or1b.items || oi1b;
var vd1b = or1bItems.findIndex(function(s) { return /verificar/i.test(s); });
var cs1b = or1bItems.findIndex(function(s) { return /sumar/i.test(s); });
console.log('Test B1b (Ordering phrasal):', vd1b < cs1b ? '✅' : '❌ Verificar dimensiones debe ir ANTES de Sumar',
    '| order:', or1bItems.map(function(s) { return s.substring(0, 30); }));

console.log('\n=== BUG FIX 2: Decimal precision - respect requested decimals ===');

// Test B2: "con 3 decimales" must not round to 2
var rb2 = QuizMathValidator.computeExpectedAnswer('Calcula 25/9 con 3 decimales');
var expectedB2 = '2.778';
console.log('Test B2 (3 decimales):', rb2 ? rb2.value.toString() : 'NULL',
    rb2 && rb2.value.toDecimalPlaces(3).toString() === expectedB2 ? '✅' : '❌ expected ' + expectedB2);

// Test B2b: Arithmetic result with 3 decimal requirement (via verify)
var qb2b = {
    type: 'fill_in_blank',
    question: 'Calcula 25000000 / 9 con 3 decimales',
    correctAnswer: '2777777.77',
    explanation: 'División con redondeo'
};
var rb2b = QuizMathValidator.verify(qb2b);
console.log('Test B2b (arith 3 dec):', rb2b ? rb2b.correctAnswer : 'NULL',
    rb2b && rb2b.correctAnswer === '2777777.778' ? '✅' : '❌ expected 2777777.778 (not 2 decimals)');

console.log('\n=== BUG FIX 3: Fraction matching in MC options ===');

// Test B3: MC with fraction options must match correctly
var qb3 = {
    type: 'multiple_choice',
    question: 'Calcula: 5/3 + 7/6',
    options: ['A) 61/6', 'B) 125/12', 'C) 10', 'D) 15'],
    correctIndex: 1,
    explanation: '5/3 + 7/6 = 10/6 + 7/6 = 17/6'
};
var rb3 = QuizMathValidator.verify(qb3);
// 5/3 + 7/6 = 10/6 + 7/6 = 17/6
console.log('Test B3 (Fraction MC):', rb3 ? 'index=' + rb3.correctIndex : 'REJECTED',
    rb3 && rb3.correctIndex === 0 ? '❌ should be index for 17/6' : '');
// Note: 17/6 ≈ 2.833, so neither 61/6 nor 125/12 matches. Should reject.

// Test B3b: Fraction MC with correct option present
var qb3b = {
    type: 'multiple_choice',
    question: 'Calcula: 3/8 + 1/9',
    options: ['A) 35/72', 'B) 125/12', 'C) 4/17', 'D) 1/2'],
    correctIndex: 2,
    explanation: '3/8 + 1/9 = 27/72 + 8/72 = 35/72'
};
var rb3b = QuizMathValidator.verify(qb3b);
console.log('Test B3b (Fraction MC correct):', rb3b ? 'index=' + rb3b.correctIndex + (rb3b.correctIndex === 0 ? ' ✅' : ' ❌ expected 0') : 'REJECTED ❌');

// Test B3c: Fraction options without letter prefix
var qb3c = {
    type: 'multiple_choice',
    question: 'Calcula: 1/4 + 1/3',
    options: ['7/12', '5/12', '1/7', '2/7'],
    correctIndex: 2,
    explanation: '1/4 + 1/3 = 3/12 + 4/12 = 7/12'
};
var rb3c = QuizMathValidator.verify(qb3c);
console.log('Test B3c (Fraction no prefix):', rb3c ? 'index=' + rb3c.correctIndex + (rb3c.correctIndex === 0 ? ' ✅' : ' ❌ expected 0') : 'REJECTED ❌');
