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
// Summary
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n═══ RESULTADO: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
