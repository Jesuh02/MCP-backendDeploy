/**
 * Test: OrderingQuestionValidator
 * Verifica que el validador detecta y corrige errores procedurales en preguntas de ordenamiento.
 */
import { OrderingQuestionValidator, DecimalCommaRule } from './src/shared/math/OrderingQuestionValidator.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// Test 1: El bug principal — coma decimal como paso independiente
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 1: Coma decimal como paso independiente (BUG PRINCIPAL) ═══'); {
    const question = 'Ordena los pasos para sumar 45.67 + 128.3';
    const items = [
        'Alinear los números por la coma decimal',
        'Escribir la coma decimal en el resultado',
        'Sumar columnas de derecha a izquierda',
        'Llevar acarreos correspondientes',
        'Verificar el resultado',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Question should be valid (corrected, not rejected)');
    assert(result.items.length === 4, `Should merge to 4 items (got ${result.items.length})`);
    assert(result.corrections && result.corrections.length > 0, 'Should report corrections');
    assert(
        result.items[0].includes('alinear') || result.items[0].includes('Alinear'),
        `First item should be alignment (got: "${result.items[0]}")`
    );
    assert(
        result.items[0].includes('coma decimal'),
        `Alignment step should include merged coma decimal info (got: "${result.items[0]}")`
    );
    assert(!result.items.some(i => /^escribir\s+la\s+coma/i.test(i)),
        'Standalone "Escribir la coma decimal" step should be removed'
    );
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Coma decimal al final (otro patrón incorrecto)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 2: Coma decimal al final ═══'); {
    const question = 'Ordena los pasos para sumar números decimales';
    const items = [
            'Alinear los números verticalmente',
        'Sumar centésimas: 7+0=7',
        'Sumar décimas: 6+3=9',
        'Sumar unidades con acarreo',
        'Colocar la coma decimal en el resultado',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after correction');
    assert(result.items.length === 4, `Should merge to 4 items (got ${result.items.length})`);
    assert(
        result.items[0].includes('coma decimal'),
        `First item should contain coma decimal (got: "${result.items[0]}")`
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Pregunta correcta — NO debe modificarse
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 3: Pregunta correcta (sin modificar) ═══');
{
    const question = 'Ordena los pasos para sumar 45.67 + 128.3';
    const items = [
        'Alinear los números por la coma decimal y marcar su posición en el resultado',
        'Sumar centésimas: 7+0=7',
        'Sumar décimas: 6+3=9',
        'Sumar unidades: 5+8=13, escribir 3, llevar 1',
        'Sumar decenas y centenas con acarreo; resultado final: 173.97',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid');
    assert(result.items.length === 5, 'Should keep all 5 items');
    assert(!result.corrections, 'Should NOT have corrections');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Verificación en medio del procedimiento
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 4: Verificación en medio ═══');
{
    const question = 'Ordena los pasos para multiplicar 234 × 56';
    const items = [
        'Multiplicar por unidades: 234 × 6',
        'Verificar el resultado',
        'Multiplicar por decenas: 234 × 50',
        'Sumar los productos parciales',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after correction');
    assert(result.items[result.items.length - 1].toLowerCase().includes('verificar'),
        'Verification should be last');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: Pregunta NO aritmética — no debe modificarse
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 5: Pregunta no aritmética (sin cambios) ═══');
{
    const question = 'Ordena los pasos para implementar QuickSort';
    const items = [
        'Seleccionar pivote',
        'Particionar el arreglo',
        'Recursión en mitad izquierda',
        'Recursión en mitad derecha',
        'Combinar resultados',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid');
    assert(result.items.length === 5, 'Should keep all 5 items');
    assert(!result.corrections, 'Should NOT modify non-arithmetic questions');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: Menos de 3 items
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 6: Menos de 3 items (rechazar) ═══');
{
    const result = OrderingQuestionValidator.validateQuestion('pregunta', ['a', 'b']);
    assert(result.valid === false, 'Should reject with < 3 items');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: "Bajar la coma decimal" pattern
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 7: "Bajar la coma decimal" ═══');
{
    const question = 'Ordena los pasos para sumar 3.14 + 2.86';
    const items = [
        'Alinear los números por el punto decimal',
        'Sumar centésimas: 4+6=10, escribir 0, llevar 1',
        'Bajar la coma decimal',
        'Sumar décimas y unidades con acarreo',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after merge');
    assert(result.items.length === 3, `Should merge to 3 items (got ${result.items.length})`);
    assert(
        !result.items.some(i => /bajar\s+la\s+coma/i.test(i)),
        '"Bajar la coma decimal" should be eliminated'
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: Alineación en posición incorrecta
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 8: Alineación en posición incorrecta ═══');
{
    const question = 'Ordena los pasos para sumar 100 + 250 + 375';
    const items = [
        'Sumar unidades: 0+0+5=5',
        'Alinear los números en columnas',
        'Sumar decenas: 0+5+7=12',
        'Sumar centenas con acarreo',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after fix');
    assert(
        result.items[0].toLowerCase().includes('alinear'),
        `Alignment should be first (got: "${result.items[0]}")`
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 9: Notación científica — convertir a decimal ANTES de alinear
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 9: Notación científica — dependencia lógica ═══');
{
    const question = 'Ordena los pasos para sumar números en notación científica: 5.678912 × 10^8 + 3.456789 × 10^7';
    const items = [
        'Alinear los números por el punto decimal',
        'Convertir a forma decimal estándar',
        'Sumar los valores alineados',
        'Redondear el resultado',
        'Verificar el resultado',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after correction');
    assert(result.corrections && result.corrections.length > 0, 'Should report corrections');

    const convertIdx = result.items.findIndex(i => /convertir/i.test(i));
    const alignIdx = result.items.findIndex(i => /alinear/i.test(i));
    assert(convertIdx >= 0, 'Convertir step should exist');
    assert(alignIdx >= 0, 'Alinear step should exist');
    assert(convertIdx < alignIdx,
        `Convertir (${convertIdx}) debe estar ANTES de Alinear (${alignIdx}). Items: ${JSON.stringify(result.items)}`
    );
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 10: Derivada — derivar ANTES de igualar a cero
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 10: Derivada — dependencia lógica ═══');
{
    const question = 'Ordena los pasos para encontrar el mínimo local de f(x) = x³ - 12x² + 45x - 10';
    const items = [
        'Igualar la derivada a cero',
        'Calcular la derivada f\'(x)',
        'Evaluar f(x) en los puntos críticos',
        'Clasificar con la segunda derivada',
        'Verificar el resultado',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after correction');

    const derivIdx = result.items.findIndex(i => /calcular\s+la\s+derivada/i.test(i));
    const zeroIdx = result.items.findIndex(i => /igualar/i.test(i));
    assert(derivIdx < zeroIdx,
        `Derivar (${derivIdx}) debe estar ANTES de Igualar a cero (${zeroIdx})`
    );
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 11: Ecuación — identificar datos ANTES de plantear ecuación
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 11: Ecuación — dependencia lógica ═══');
{
    const question = 'Ordena los pasos para resolver el problema';
    const items = [
        'Plantear la ecuación',
        'Identificar los datos del problema',
        'Resolver la ecuación',
        'Verificar el resultado',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after correction');

    const identIdx = result.items.findIndex(i => /identificar/i.test(i));
    const plantIdx = result.items.findIndex(i => /plantear/i.test(i));
    assert(identIdx < plantIdx,
        `Identificar (${identIdx}) debe estar ANTES de Plantear (${plantIdx})`
    );
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 12: Orden ya correcto — NO debe modificarse
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 12: Notación científica en orden correcto ═══');
{
    const question = 'Ordena los pasos para sumar en notación científica';
    const items = [
        'Convertir a forma decimal',
        'Alinear los números por el punto decimal',
        'Sumar columnas de derecha a izquierda',
        'Verificar el resultado',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid');
    // StepDependencyOrderRule should NOT produce corrections for this
    const hasDependencyCorrection = result.corrections?.some(c => /convertir/i.test(c));
    assert(!hasDependencyCorrection, 'Should NOT have dependency corrections when order is already correct');
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 13: Operación ANTES de redondeo
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 13: Redondear DESPUÉS de calcular ═══');
{
    const question = 'Ordena los pasos para calcular el total de la compra';
    const items = [
        'Redondear el resultado a 2 decimales',
        'Calcular el total multiplicando cantidad por precio',
        'Verificar el resultado',
    ];

    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid === true, 'Should be valid after correction');

    const calcIdx = result.items.findIndex(i => /calcular/i.test(i));
    const roundIdx = result.items.findIndex(i => /redondear/i.test(i));
    assert(calcIdx < roundIdx,
        `Calcular (${calcIdx}) debe estar ANTES de Redondear (${roundIdx})`
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 14: Verificar convergencia NO debe ir al final (es prerequisito)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 14: Verificar convergencia como prerequisito ═══'); {
    const question = 'Ordena los pasos para calcular la suma de una serie geométrica infinita';
    const items = [
        'Identificar los valores de a₁ y r',
        'Verificar convergencia: |r| < 1',
        'Aplicar la fórmula S = a₁/(1-r)',
        'Escribir el resultado final',
        'Verificar el resultado',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid');
    const verifyConvergIdx = result.items.findIndex(i => /convergencia/.test(i));
    const applyIdx = result.items.findIndex(i => /aplicar.*f[oó]rmula/i.test(i));
    const verifyResultIdx = result.items.findIndex(i => /verificar\s+el\s+resultado/i.test(i));
    assert(verifyConvergIdx < applyIdx,
        `"Verificar convergencia" (${verifyConvergIdx}) debe estar ANTES de "Aplicar fórmula" (${applyIdx})`);
    assert(verifyResultIdx === result.items.length - 1,
        `"Verificar el resultado" debe ser el ÚLTIMO paso (pos ${verifyResultIdx})`);
    assert(verifyConvergIdx !== result.items.length - 1,
        `"Verificar convergencia" NO debe ser el último paso (pos ${verifyConvergIdx})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 15: Verificar dimensiones NO debe ir al final (es prerequisito)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 15: Verificar dimensiones de matrices ═══'); {
    const question = 'Ordena los pasos para sumar dos matrices';
    const items = [
        'Verificar dimensiones de las matrices',
        'Sumar las matrices elemento por elemento',
        'Escribir el resultado final',
        'Verificar el resultado',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid');
    const dimIdx = result.items.findIndex(i => /dimensiones/.test(i));
    const sumIdx = result.items.findIndex(i => /sumar.*matrices/i.test(i));
    assert(dimIdx < sumIdx,
        `"Verificar dimensiones" (${dimIdx}) debe estar ANTES de "Sumar matrices" (${sumIdx})`);
    assert(dimIdx === 0, `"Verificar dimensiones" debe ser el primer paso (pos ${dimIdx})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 16: Resultado provisional ANTES de redondear
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 16: Resultado provisional antes de redondeo ═══'); {
    const question = 'Ordena los pasos para sumar y redondear a 3 decimales';
    const items = [
        'Alinear verticalmente los números por el punto decimal',
        'Sumar columna por columna de derecha a izquierda',
        'Escribir el resultado provisional con todos los decimales: 2999.999988',
        'Identificar el cuarto decimal para redondear a 3 decimales',
        'Aplicar redondeo: resultado final 3000.000',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid');
    const provisionalIdx = result.items.findIndex(i => /resultado\s+provisional/i.test(i));
    const identifyIdx = result.items.findIndex(i => /identificar.*decimal/i.test(i));
    const roundIdx = result.items.findIndex(i => /aplicar\s+redondeo/i.test(i));
    assert(provisionalIdx < identifyIdx,
        `"Resultado provisional" (${provisionalIdx}) debe estar ANTES de "Identificar dígito" (${identifyIdx})`);
    assert(identifyIdx < roundIdx,
        `"Identificar dígito" (${identifyIdx}) debe estar ANTES de "Aplicar redondeo" (${roundIdx})`);
    console.log('  Items:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 17: WriteResultLastRule NO debe mover "resultado provisional"
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 17: Resultado provisional no se mueve al final ═══'); {
    const question = 'Ordena los pasos para sumar y redondear';
    const items = [
        'Alinear los números',
        'Sumar columnas',
        'Escribir el resultado provisional con todos los decimales',
        'Identificar el dígito de redondeo',
        'Aplicar el redondeo',
        'Verificar el resultado',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid');
    const provisionalIdx = result.items.findIndex(i => /resultado\s+provisional/i.test(i));
    const roundIdx = result.items.findIndex(i => /aplicar.*redondeo/i.test(i));
    assert(provisionalIdx < roundIdx,
        `"Resultado provisional" (${provisionalIdx}) debe quedar ANTES de "Aplicar redondeo" (${roundIdx}), no moverse al final`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 18: Bug reportado — resultado provisional en posición incorrecta
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 18: BUG: Resultado provisional al final (debe estar antes de redondeo) ═══'); {
    const question = 'Ordena los pasos para sumar cuatro números con muchos decimales y redondear el resultado a 3 decimales';
    const items = [
        'Alinear verticalmente los números por el punto decimal',
        'Sumar columna por columna de derecha a izquierda',
        'Identificar el cuarto decimal (diezmilésimas) para redondear a 3 decimales',
        'Aplicar redondeo: resultado final 3000.000',
        'Escribir el resultado provisional con todos los decimales: 2999.999988',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid after correction');
    assert(result.corrections && result.corrections.length > 0, 'Should have corrections');
    const provisionalIdx = result.items.findIndex(i => /resultado\s+provisional/i.test(i));
    const identifyIdx = result.items.findIndex(i => /identificar.*decimal/i.test(i));
    const roundIdx = result.items.findIndex(i => /aplicar\s+redondeo/i.test(i));
    assert(provisionalIdx < identifyIdx,
        `"Resultado provisional" (${provisionalIdx}) debe estar ANTES de "Identificar dígito" (${identifyIdx})`);
    assert(identifyIdx < roundIdx,
        `"Identificar dígito" (${identifyIdx}) debe estar ANTES de "Aplicar redondeo" (${roundIdx})`);
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 19: Bug reportado — Verificar convergencia como último paso
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 19: BUG: Verificar convergencia al final (debe ser prerequisito) ═══'); {
    const question = 'Ordena los pasos para calcular la suma de una serie geométrica infinita';
    const items = [
        'Identificar los valores de a₁ y r',
        'Aplicar la fórmula S = a₁/(1-r)',
        'Escribir el resultado final',
        'Verificar convergencia: |r| < 1',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid after correction');
    const convIdx = result.items.findIndex(i => /convergencia/i.test(i));
    const applyIdx = result.items.findIndex(i => /aplicar.*f[oó]rmula/i.test(i));
    assert(convIdx < applyIdx,
        `"Verificar convergencia" (${convIdx}) debe estar ANTES de "Aplicar fórmula" (${applyIdx})`);
    assert(convIdx !== result.items.length - 1,
        `"Verificar convergencia" NO debe ser el último paso (pos ${convIdx})`);
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 20: Bug reportado — Verificar dimensiones al final en matrices
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 20: BUG: Verificar dimensiones al final en matrices ═══'); {
    const question = 'Ordena los pasos para sumar dos matrices';
    const items = [
        'Sumar las matrices elemento por elemento',
        'Escribir la matriz resultado',
        'Verificar el resultado',
        'Verificar dimensiones de las matrices',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid after correction');
    const dimIdx = result.items.findIndex(i => /dimensiones/i.test(i));
    const sumIdx = result.items.findIndex(i => /sumar.*matri/i.test(i));
    assert(dimIdx < sumIdx,
        `"Verificar dimensiones" (${dimIdx}) debe estar ANTES de "Sumar matrices" (${sumIdx})`);
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 21: Cadena completa de redondeo — calcular → provisional → dígito → redondear
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Test 21: Cadena completa de redondeo en orden incorrecto ═══'); {
    const question = 'Ordena los pasos para sumar y redondear a 2 decimales';
    const items = [
        'Identificar el tercer decimal para redondear',
        'Alinear los números por el punto decimal',
        'Aplicar redondeo al resultado',
        'Escribir el resultado provisional con todos los decimales',
        'Sumar columna por columna',
    ];
    const result = OrderingQuestionValidator.validateQuestion(question, items);
    assert(result.valid, 'Should be valid after correction');

    const alignIdx = result.items.findIndex(i => /alinear/i.test(i));
    const sumIdx = result.items.findIndex(i => /sumar.*columna/i.test(i));
    const provIdx = result.items.findIndex(i => /resultado\s+provisional/i.test(i));
    const digitIdx = result.items.findIndex(i => /identificar.*decimal/i.test(i));
    const roundIdx = result.items.findIndex(i => /aplicar\s+redondeo/i.test(i));

    assert(alignIdx < sumIdx, `Alinear (${alignIdx}) debe ir ANTES de Sumar (${sumIdx})`);
    assert(sumIdx < provIdx, `Sumar (${sumIdx}) debe ir ANTES de Provisional (${provIdx})`);
    assert(provIdx < digitIdx, `Provisional (${provIdx}) debe ir ANTES de Identificar dígito (${digitIdx})`);
    assert(digitIdx < roundIdx, `Identificar dígito (${digitIdx}) debe ir ANTES de Redondear (${roundIdx})`);
    console.log('  Items corregidos:', result.items);
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n═══ RESULTADO: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
