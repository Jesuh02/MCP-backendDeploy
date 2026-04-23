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

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 4: Rounding cascade — "3000" vs "3000.000" (precision-aware MC)
// The system must prefer "3000.000" over "3000" when 3 decimals are requested.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 4: Precision-aware MC option matching ===');

// Test B4a: Rounding cascade — 2999.999988 rounded to 3 decimals = 3000.000
var qb4a = {
    type: 'multiple_choice',
    question: 'Calcula la suma de 1500.123456 + 1499.876532 y redondea a 3 decimales',
    options: ['A) 3000', 'B) 2999.999', 'C) 3000.000', 'D) 3000.001'],
    correctIndex: 0,
    explanation: 'La suma es 2999.999988, redondeado: 3000.000'
};
var rb4a = QuizMathValidator.verify(qb4a);
console.log('Test B4a (Rounding cascade MC):', rb4a ? 'index=' + rb4a.correctIndex + (rb4a.correctIndex === 2 ? ' ✅' : ' ❌ expected 2 (C: 3000.000)') : 'REJECTED ❌');

// Test B4b: Fill-in-blank with precision formatting
var qb4b = {
    type: 'fill_in_blank',
    question: 'Calcula la suma de 1500.123456 + 1499.876532 y redondea a 3 decimales',
    correctAnswer: '3000',
    explanation: 'La suma redondeada'
};
var rb4b = QuizMathValidator.verify(qb4b);
console.log('Test B4b (Fill precision):', rb4b ? rb4b.correctAnswer + (rb4b.correctAnswer === '3000.000' ? ' ✅' : ' ❌ expected 3000.000') : 'NULL ❌');

// Test B4c: Integer rounding — should prefer "3000" not "3000.000"
var qb4c = {
    type: 'multiple_choice',
    question: 'Calcula la suma de 1500.123456 + 1499.876532. Redondea a entero',
    options: ['A) 3000', 'B) 2999', 'C) 3000.000', 'D) 3001'],
    correctIndex: 2,
    explanation: 'Redondeado al entero más cercano'
};
var rb4c = QuizMathValidator.verify(qb4c);
console.log('Test B4c (Integer rounding MC):', rb4c ? 'index=' + rb4c.correctIndex + (rb4c.correctIndex === 0 ? ' ✅' : ' ❌ expected 0 (A: 3000)') : 'REJECTED ❌');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 5: Multi-step sum + tax — sum must resolve BEFORE tax is applied
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 5: Multi-step sum + tax ===');

// Test B5a: Sum labeled values + IVA
var qb5a = {
    type: 'fill_in_blank',
    question: 'Los gastos son: alquiler $500, comida $300, transporte $200. Calcula el gasto total con IVA del 16%',
    correctAnswer: '1000',
    explanation: 'Suma + IVA'
};
var rb5a = QuizMathValidator.verify(qb5a);
console.log('Test B5a (Sum+IVA):', rb5a ? rb5a.correctAnswer + (rb5a.correctAnswer === '1160' ? ' ✅' : ' ❌ expected 1160') : 'NULL ❌');

// Test B5b: Sum currency values + impuesto
var qb5b = {
    type: 'fill_in_blank',
    question: 'Calcula el total: $1500 + $2300 + $750. Agrega un impuesto del 10%',
    correctAnswer: '4550',
    explanation: 'Suma con impuesto'
};
var rb5b = QuizMathValidator.verify(qb5b);
console.log('Test B5b (Sum+Tax):', rb5b ? rb5b.correctAnswer + (rb5b.correctAnswer === '5005' ? ' ✅' : ' ❌ expected 5005') : 'NULL ❌');

// Test B5c: Division with 3 decimal precision
var qb5c = {
    type: 'fill_in_blank',
    question: 'Calcula 25000000 / 9 con 3 decimales',
    correctAnswer: '2777777.77',
    explanation: 'División con redondeo'
};
var rb5c = QuizMathValidator.verify(qb5c);
console.log('Test B5c (Div 3 dec):', rb5c ? rb5c.correctAnswer + (rb5c.correctAnswer === '2777777.778' ? ' ✅' : ' ❌ expected 2777777.778') : 'NULL ❌');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 6: Explanation must match selected answer
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 6: Explanation-answer consistency ===');

// Test B6a: When validator corrects MC index, explanation must reflect the correction
var qb6a = {
    type: 'multiple_choice',
    question: 'Calcula: 500 + 300 + 200',
    options: ['A) 900', 'B) 1000', 'C) 1100', 'D) 800'],
    correctIndex: 1,
    explanation: 'El resultado es 1000'
};
var rb6a = QuizMathValidator.verify(qb6a);
var b6aExplHas1000 = rb6a && rb6a.explanation && rb6a.explanation.indexOf('1000') !== -1;
console.log('Test B6a (Explanation consistency):', rb6a ? 'index=' + rb6a.correctIndex +
    (rb6a.correctIndex === 1 ? ' ✅' : ' ❌ expected 1') +
    (b6aExplHas1000 ? ' explanation✅' : ' explanation❌') : 'REJECTED ❌');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 7: Decimal precision — answer must NOT be truncated to 2 decimals
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 7: Decimal precision (no truncation) ===');

// Test B7a: 25000/9 = 2777.777... — fill_in_blank should preserve 3+ decimals
var qb7a = {
    type: 'fill_in_blank',
    question: 'Dividir 25000 entre 9',
    correctAnswer: '2777.78',  // LLM gave wrong 2-decimal answer
    explanation: 'El resultado es 2777.78'
};
var rb7a = QuizMathValidator.verify(qb7a);
// The computed answer is 2777.777... repeating — validator should NOT truncate to 2777.78
var b7aVal = rb7a ? rb7a.correctAnswer : 'NULL';
var b7aCorrect = b7aVal && b7aVal.indexOf('2777.77') === 0;
console.log('Test B7a (Decimal precision):', b7aVal, b7aCorrect ? '✅' : '❌ expected 2777.77...');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 8: Combined formula — S₁ (polynomial) + S₂ (geometric sigma)
// Must compute BOTH parts, not just S₁
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 8: Combined S₁ + S₂ (sigma geometric) ===');

// Test B8a: Σ(i=1 to 100)(2i+1) + Σ(k=1 to 50) 3·2^{k-1}
var textB8a = 'Calcula S₁ + S₂ donde S₁ = Σ (de i=1 a 100) de (2i + 1) y S₂ es la serie geométrica: 3, 6, 12, 24 (primeros 50 términos)';
var rb8a = QuizMathValidator.computeExpectedAnswer(textB8a);
// S₁ = Σ(2i+1) from 1 to 100 = 2·(100·101/2) + 100 = 10100 + 100 = 10200
// S₂ = 3·(2^50 - 1)/(2 - 1) = 3·(1125899906842623) = 3377699720527869
// Total = 3377699720538069
console.log('Test B8a (Combined S₁+S₂):', rb8a ? rb8a.value.toExponential(6) : 'NULL',
    rb8a && rb8a.value.gt(1e15) ? '✅ (correctly includes S₂)' : '❌ S₂ was ignored — value too small');

// Test B8b: Sigma notation geometric Σ_{k=1}^{50} 3·2^{k-1}
var textB8b = 'Calcula la sumatoria: Σ (de k=1 a 50) de (3·2^{k-1})';
var rb8b = QuizMathValidator.computeExpectedAnswer(textB8b);
console.log('Test B8b (Sigma geometric only):', rb8b ? rb8b.value.toExponential(6) : 'NULL',
    rb8b && rb8b.value.gt(1e15) ? '✅' : '❌ expected ~3.38e15');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 9: Sum-then-discount (multiple values + percentage)
// Must sum ALL values first, THEN apply discount
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 9: Sum-then-discount (no partial data) ===');

// Test B9a: Sum 4 quarterly values, then apply 15% discount
var textB9a = 'Una empresa reportó ingresos trimestrales: Q1=$12,500,000, Q2=$13,200,000, Q3=$15,555,555.55, Q4=$11,800,000. Calcula el gasto total anual con un descuento del 15%.';
var rb9a = QuizMathValidator.computeExpectedAnswer(textB9a);
// Total = 12500000 + 13200000 + 15555555.55 + 11800000 = 53055555.55
// With 15% discount: 53055555.55 × 0.85 = 45097222.2175
console.log('Test B9a (Sum-then-discount):', rb9a ? rb9a.value.toString() : 'NULL');
var b9aExpected = rb9a && rb9a.value.gt(40000000);
console.log('  Total > 40M:', b9aExpected ? '✅ (used all 4 quarters)' : '❌ (likely used only 1 value)');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 10: 4-operand omission — system summed only 3 of 4 numbers
// Root cause: [\d,.]+ regex captured sentence-ending period (.) as part of
// the last number, creating a double-dot value that _parseDecimal rejected.
// Also: Pattern C in _tryExplicitSumProblem couldn't distinguish commas
// inside numbers (thousands) from commas between list items.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 10: 4-operand omission ===');

// Test B10a: Q-labeled values with sentence-ending period after last number
var textB10a = 'Una empresa reporta valores trimestrales: Q1=$12,345,678.9876, Q2=$9,876,543.2109, Q3=$5,555,555.5555, Q4=$2,222,222.2222. ¿Cuánto es el monto total?';
var rb10a = QuizMathValidator.computeExpectedAnswer(textB10a);
console.log('Test B10a (4 Q-labeled $):', rb10a ? rb10a.value.toString() : 'NULL',
    rb10a && rb10a.value.toString() === '29999999.9762' ? '✅' : '❌ expected 29999999.9762');

// Test B10b: Comma-separated list with "y" connector and thousands separators
var textB10b = 'Calcula la suma total de los valores 12,345,678.9876, 9,876,543.2109, 5,555,555.5555 y 2,222,222.2222';
var rb10b = QuizMathValidator.computeExpectedAnswer(textB10b);
console.log('Test B10b (comma-list + y):', rb10b ? rb10b.value.toString() : 'NULL',
    rb10b && rb10b.value.toString() === '29999999.9762' ? '✅' : '❌ expected 29999999.9762');

// Test B10c: Digit-position problem must use ALL 4 numbers
var textB10c = '¿Cuál es el dígito en la posición de las decenas de millón de la suma de 12,345,678.9876 + 9,876,543.2109 + 5,555,555.5555 + 2,222,222.2222 redondeada a 3 decimales?';
var rb10c = QuizMathValidator.computeExpectedAnswer(textB10c);
// Sum = 29,999,999.9762 → int = 29999999 → decenas de millón (10^7) = 2
console.log('Test B10c (digit pos 4 nums):', rb10c ? rb10c.value.toString() : 'NULL',
    rb10c && rb10c.value.toString() === '2' ? '✅' : '❌ expected 2 (NOT 7 from 3-number sum)');

// Test B10d: verify() must correct LLM answer based on 3 numbers to correct 4-number answer
var qb10d = {
    type: 'fill_in_blank',
    question: '¿Cuál es el dígito en la posición de las decenas de millón de la suma de 12,345,678.9876 + 9,876,543.2109 + 5,555,555.5555 + 2,222,222.2222 redondeada a 3 decimales?',
    correctAnswer: '7',
    explanation: 'La suma es 27,777,777.754, el dígito en decenas de millón es 7'
};
var rb10d = QuizMathValidator.verify(qb10d);
console.log('Test B10d (verify corrects 7→2):', rb10d ? rb10d.correctAnswer : 'NULL',
    rb10d && rb10d.correctAnswer === '2' ? '✅' : '❌ expected 2');

// Test B10e: Labeled values without $ (A=, B=, C=, D=) ending with period
var textB10e = 'Calcula la suma de los siguientes valores: A = 12,345,678.9876, B = 9,876,543.2109, C = 5,555,555.5555, D = 2,222,222.2222.';
var rb10e = QuizMathValidator.computeExpectedAnswer(textB10e);
console.log('Test B10e (labeled A=B=C=D=.):', rb10e ? rb10e.value.toString() : 'NULL',
    rb10e && rb10e.value.toString() === '29999999.9762' ? '✅' : '❌ expected 29999999.9762');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 11: Tax not applied — "impuesto corporativo del 18.5%"
// The system computed the gross total correctly but failed to apply the tax
// because the regex didn't allow modifier words (like "corporativo") between
// the keyword "impuesto" and "del X%".
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 11: Corporate tax / modifier words in tax regex ===');

// Test B11a: Sum + corporate tax (deduction)
var textB11a = 'Una empresa reportó ingresos trimestrales: Q1=$5,000,000, Q2=$6,000,000, Q3=$7,591,348, Q4=$6,000,000. Calcula el monto final después de aplicar un impuesto corporativo del 18.5%. Redondea al entero';
var rb11a = QuizMathValidator.computeExpectedAnswer(textB11a);
// Total = 5000000 + 6000000 + 7591348 + 6000000 = 24591348
// After 18.5% corporate tax (deduction): 24591348 × (1 - 0.185) = 24591348 × 0.815 = 20041948.62 → 20041949
console.log('Test B11a (Sum + corporate tax):', rb11a ? rb11a.value.toString() : 'NULL');
var b11aExpected = rb11a && rb11a.value.toDecimalPlaces(0).toString() === '20041949';
console.log('  Expected 20041949:', b11aExpected ? '✅' : '❌ (tax was NOT applied or wrong)');

// Test B11b: Single value + impuesto corporativo
var textB11b = 'Un ingreso de $100,000 con impuesto corporativo del 30%. ¿Cuál es el monto neto?';
var rb11b = QuizMathValidator.computeExpectedAnswer(textB11b);
// 100000 × (1 - 0.30) = 70000
console.log('Test B11b (Single + corporate tax):', rb11b ? rb11b.value.toString() : 'NULL',
    rb11b && rb11b.value.toString() === '70000' ? '✅' : '❌ expected 70000');

// Test B11c: Impuesto sobre la renta
var textB11c = 'Calcula el ingreso neto de $50,000 después de aplicar un impuesto sobre la renta del 25%';
var rb11c = QuizMathValidator.computeExpectedAnswer(textB11c);
// 50000 × (1 - 0.25) = 37500
console.log('Test B11c (Income tax):', rb11c ? rb11c.value.toString() : 'NULL',
    rb11c && rb11c.value.toString() === '37500' ? '✅' : '❌ expected 37500');

// Test B11d: IVA should still ADD (not deduct)
var textB11d = 'Calcula el total de $1000 con IVA del 16%';
var rb11d = QuizMathValidator.computeExpectedAnswer(textB11d);
console.log('Test B11d (IVA still adds):', rb11d ? rb11d.value.toString() : 'NULL',
    rb11d && rb11d.value.toString() === '1160' ? '✅' : '❌ expected 1160 (IVA adds, not deducts)');

// Test B11e: verify() must correct when tax was omitted
var qb11e = {
    type: 'fill_in_blank',
    question: 'Una empresa tiene ingresos de $24,591,348. Calcula el monto final después de un impuesto corporativo del 18.5%. Redondea al entero',
    correctAnswer: '24591348',
    explanation: 'El ingreso total es 24591348'
};
var rb11e = QuizMathValidator.verify(qb11e);
console.log('Test B11e (verify corrects missing tax):', rb11e ? rb11e.correctAnswer : 'NULL',
    rb11e && rb11e.correctAnswer === '20041949' ? '✅' : '❌ expected 20041949');

// Test B11f: Sum + impuesto estatal (another modifier word)
var textB11f = 'Ventas totales: $10,000 + $15,000 + $25,000. Aplica impuesto estatal del 10%';
var rb11f = QuizMathValidator.computeExpectedAnswer(textB11f);
// Sum = 50000, + 10% = 55000 (estatal is not deductible)
console.log('Test B11f (Sum + state tax):', rb11f ? rb11f.value.toString() : 'NULL',
    rb11f && rb11f.value.toString() === '55000' ? '✅' : '❌ expected 55000');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 12: Digit sum — system stopped at intermediate result
// The system computed the sum correctly but ignored the instruction to
// calculate the sum of the individual digits of the result.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== BUG FIX 12: Digit sum post-processing ===');

// Test B12a: Sum of 4 integers, then sum of digits
var textB12a = 'Suma los siguientes enteros: 9,876,543 + 8,765,432 + 7,654,321 + 6,543,210. Luego calcula la suma de sus dígitos individuales';
var rb12a = QuizMathValidator.computeExpectedAnswer(textB12a);
// Sum = 32,839,506 → digits: 3+2+8+3+9+5+0+6 = 36
console.log('Test B12a (Sum then digit sum):', rb12a ? rb12a.value.toString() : 'NULL',
    rb12a && rb12a.value.toString() === '36' ? '✅' : '❌ expected 36 (NOT 32839506)');

// Test B12b: Single number digit sum
var textB12b = '¿Cuál es la suma de los dígitos de 123456789?';
var rb12b = QuizMathValidator.computeExpectedAnswer(textB12b);
// 1+2+3+4+5+6+7+8+9 = 45
console.log('Test B12b (Single number digit sum):', rb12b ? rb12b.value.toString() : 'NULL',
    rb12b && rb12b.value.toString() === '45' ? '✅' : '❌ expected 45');

// Test B12c: verify() must correct fill_in_blank that gave intermediate result
var qb12c = {
    type: 'fill_in_blank',
    question: 'Suma 9,876,543 + 8,765,432 + 7,654,321 + 6,543,210 y calcula la suma de sus dígitos individuales',
    correctAnswer: '32839506',
    explanation: 'La suma es 32839506'
};
var rb12c = QuizMathValidator.verify(qb12c);
console.log('Test B12c (verify digit sum correction):', rb12c ? rb12c.correctAnswer : 'NULL',
    rb12c && rb12c.correctAnswer === '36' ? '✅' : '❌ expected 36');

// Test B12d: MC with digit sum answer
var qb12d = {
    type: 'multiple_choice',
    question: 'Calcula 5000 + 3000 + 2000 y encuentra la suma de los dígitos del resultado',
    options: ['A) 10000', 'B) 10', 'C) 1', 'D) 100'],
    correctIndex: 0,
    explanation: 'El resultado es 10000'
};
var rb12d = QuizMathValidator.verify(qb12d);
// 5000+3000+2000 = 10000, digits: 1+0+0+0+0 = 1
console.log('Test B12d (MC digit sum):', rb12d ? 'index=' + rb12d.correctIndex + (rb12d.correctIndex === 2 ? ' ✅' : ' ❌ expected 2 (C: 1)') : 'REJECTED ❌');

// Test B12e: Sumar los dígitos variant
var textB12e = 'Calcula 999 + 111 y luego suma los dígitos del resultado';
var rb12e = QuizMathValidator.computeExpectedAnswer(textB12e);
// 999 + 111 = 1110, digits: 1+1+1+0 = 3
console.log('Test B12e (Sumar dígitos variant):', rb12e ? rb12e.value.toString() : 'NULL',
    rb12e && rb12e.value.toString() === '3' ? '✅' : '❌ expected 3');

// Test B12f: Normal sum should NOT trigger digit sum
var textB12f = 'Calcula la suma total: $1500 + $2300 + $750';
var rb12f = QuizMathValidator.computeExpectedAnswer(textB12f);
console.log('Test B12f (Normal sum, no digit sum):', rb12f ? rb12f.value.toString() : 'NULL',
    rb12f && rb12f.value.toString() === '4550' ? '✅' : '❌ expected 4550 (should NOT do digit sum)');

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 13: Rounding variants must ALL trigger integer rounding
// Real bug: "57,150,617.17953" must become "57150617" when problem ends with
// "redondea al entero más cercano" or similar phrasings.
// Test _applyDecimals directly for deterministic regex coverage.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== BUG FIX 13: Robust integer rounding variants (_applyDecimals) ===');

// Import Decimal for direct _applyDecimals tests
const DecimalMod = (await import('decimal.js')).default;

function testRound(label, text, rawValue, expected) {
    var v = new DecimalMod(rawValue);
    var out = QuizMathValidator._applyDecimals(v, text);
    var got = out.toString();
    console.log(label + ':', got, got === expected ? '✅' : '❌ expected ' + expected + ' (input text: "' + text + '")');
}

// B13a: real user case — "redondea al entero más cercano"
testRound(
    'Test B13a (al entero más cercano)',
    'Calcula el monto y redondea al entero más cercano',
    '57150617.17953',
    '57150617'
);

// B13b: "al número entero más cercano"
testRound(
    'Test B13b (al número entero más cercano)',
    'redondea al número entero más cercano',
    '2.7777',
    '3'
);

// B13c: "redondeado al entero"
testRound(
    'Test B13c (redondeado al entero)',
    'el resultado redondeado al entero',
    '1234.567',
    '1235'
);

// B13d: "al peso más cercano"
testRound(
    'Test B13d (al peso más cercano)',
    'expresa el monto al peso más cercano',
    '1777.5',
    '1778'
);

// B13e: "sin decimales"
testRound(
    'Test B13e (sin decimales)',
    'da el resultado sin decimales',
    '166.5',
    '167'
);

// B13f: "expresa como número entero"
testRound(
    'Test B13f (expresa como número entero)',
    'expresa el resultado como número entero',
    '1369.5',
    '1370'
);

// B13g: "al centavo más cercano" → 2 decimals
testRound(
    'Test B13g (al centavo más cercano)',
    'redondea al centavo más cercano',
    '33.33333',
    '33.33'
);

// B13h: "aproxima al entero"
testRound(
    'Test B13h (aproxima al entero)',
    'aproxima al entero',
    '99.6',
    '100'
);

// B13i: "en pesos enteros"
testRound(
    'Test B13i (en pesos enteros)',
    'expresa la respuesta en pesos enteros',
    '4321.78',
    '4322'
);

// B13j: existing "3 decimales" still works
testRound(
    'Test B13j (3 decimales)',
    'Calcula con 3 decimales',
    '2.77777',
    '2.778'
);

// B13k: existing "redondea a entero" still works (regression)
testRound(
    'Test B13k (redondea a entero)',
    'Redondea a entero',
    '46089.5',
    '46090'
);

// B13l: no rounding signal → value unchanged
testRound(
    'Test B13l (no signal)',
    'Calcula el total',
    '57150617.17953',
    '57150617.17953'
);

// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX 14: Base Conversion — convert EACH number independently FIRST
// Root cause of reported error: system operated in octal BEFORE converting,
// polluting all subsequent steps with a wrong intermediate value.
//
// Correct methodology:
//   744₈ → 484₁₀  (independently)
//   362₈ → 242₁₀  (independently)
//   Sum in base 10: 484 + 242 = 726
//   Then add 489₁₀: 726 + 489 = 1215
//   Express in hex:  1215 = 4BF₁₆
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== BUG FIX 14: Base Conversion — convert each number independently ===');

// Test B14a: Octal + Octal (subscript notation)
var rb14a = QuizMathValidator.computeExpectedAnswer('Calcula la suma de 744\u2088 + 362\u2088');
// 744₈ = 7×64 + 4×8 + 4 = 484, 362₈ = 3×64 + 6×8 + 2 = 242, sum = 726
console.log('Test B14a (octal+octal \u2088):', rb14a ? rb14a.value.toString() : 'NULL',
    rb14a && rb14a.value.toString() === '726' ? '\u2705' : '\u274C expected 726 (NOT 727 \u2014 system must NOT sum in octal first)');

// Test B14b: Octal + Decimal + Hex chain with output in hex
var rb14b = QuizMathValidator.computeExpectedAnswer(
    'Suma 744\u2088 + 362\u2088 + 489 y expresa el resultado en hexadecimal'
);
// 484 + 242 + 489 = 1215 = 4BF₁₆
console.log('Test B14b (octal+octal+decimal\u2192hex):', rb14b ? rb14b.value.toString() + ' baseRepr=' + (rb14b.baseRepresentation || 'none') : 'NULL',
    rb14b && rb14b.value.toString() === '1215' && rb14b.baseRepresentation === '4BF' ? '\u2705' : '\u274C expected value=1215 baseRepresentation=4BF');

// Test B14c: Pure octal-to-decimal conversion
var rb14c = QuizMathValidator.computeExpectedAnswer('Convierte 745\u2088 a decimal');
// 745₈ = 7×64 + 4×8 + 5 = 485
console.log('Test B14c (pure octal\u2192decimal):', rb14c ? rb14c.value.toString() : 'NULL',
    rb14c && rb14c.value.toString() === '485' ? '\u2705' : '\u274C expected 485');

// Test B14d: Hexadecimal to decimal (subscript notation)
var rb14d = QuizMathValidator.computeExpectedAnswer('Convierte 3A5\u2081\u2086 a decimal');
// 3×256 + 10×16 + 5 = 768 + 160 + 5 = 933
console.log('Test B14d (hex\u2192decimal \u2081\u2086):', rb14d ? rb14d.value.toString() : 'NULL',
    rb14d && rb14d.value.toString() === '933' ? '\u2705' : '\u274C expected 933');

// Test B14e: Binary to decimal (subscript notation)
var rb14e = QuizMathValidator.computeExpectedAnswer('Convierte 1010\u2082 a decimal');
// 1010₂ = 8 + 2 = 10
console.log('Test B14e (binary\u2192decimal \u2082):', rb14e ? rb14e.value.toString() : 'NULL',
    rb14e && rb14e.value.toString() === '10' ? '\u2705' : '\u274C expected 10');

// Test B14f: C-style prefix 0xFF
var rb14f = QuizMathValidator.computeExpectedAnswer('\u00bfCu\u00e1nto vale 0xFF en decimal?');
// 0xFF = 255
console.log('Test B14f (0xFF\u2192decimal):', rb14f ? rb14f.value.toString() : 'NULL',
    rb14f && rb14f.value.toString() === '255' ? '\u2705' : '\u274C expected 255');

// Test B14g: Keyword notation "octal"
var rb14g = QuizMathValidator.computeExpectedAnswer('Suma 745 octal + 362 octal');
// 745₈ = 485, 362₈ = 242, sum = 727
console.log('Test B14g (keyword octal):', rb14g ? rb14g.value.toString() : 'NULL',
    rb14g && rb14g.value.toString() === '727' ? '\u2705' : '\u274C expected 727');

// Test B14h: verify() must correct MC answer for octal sum
var qb14h = {
    type: 'multiple_choice',
    question: 'Calcula la suma de 744\u2088 + 362\u2088. \u00bfCu\u00e1l es el resultado en base 10?',
    options: ['A) 727', 'B) 726', 'C) 1327', 'D) 700'],
    correctIndex: 0,   // LLM said 727 (wrong — summed in octal first)
    explanation: 'Sumando en octal: 744+362=1327, convertido: 727'
};
var rb14h = QuizMathValidator.verify(qb14h);
console.log('Test B14h (verify MC octal error):', rb14h ? 'index=' + rb14h.correctIndex + (rb14h.correctIndex === 1 ? ' \u2705' : ' \u274C expected 1 (B: 726)') : 'REJECTED \u274C');

// Test B14i: Binary sum
var rb14i = QuizMathValidator.computeExpectedAnswer('Suma 1010\u2082 + 0110\u2082 en decimal');
// 10 + 6 = 16
console.log('Test B14i (binary sum):', rb14i ? rb14i.value.toString() : 'NULL',
    rb14i && rb14i.value.toString() === '16' ? '\u2705' : '\u274C expected 16');

// Test B14j: Hex sum with 0x prefix
var rb14j = QuizMathValidator.computeExpectedAnswer('Calcula 0x1A + 0x06 en decimal');
// 26 + 6 = 32
console.log('Test B14j (0x prefix hex sum):', rb14j ? rb14j.value.toString() : 'NULL',
    rb14j && rb14j.value.toString() === '32' ? '\u2705' : '\u274C expected 32');

console.log('\n--- All tests completed ---');
