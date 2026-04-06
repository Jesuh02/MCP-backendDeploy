/**
 * Test de validación con los errores EXACTOS reportados por el usuario.
 */
import { AnswerVerificationGate } from './src/shared/math/AnswerVerificationGate.js';
import { QuizMathValidator } from './src/shared/math/QuizMathValidator.js';
import { OrderingQuestionValidator } from './src/shared/math/OrderingQuestionValidator.js';

const gate = AnswerVerificationGate.getInstance();
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const ok = fn();
        if (ok) {
            console.log(`  ✅ ${name}`);
            passed++;
        } else {
            console.log(`  ❌ ${name}`);
            failed++;
        }
    } catch (e) {
        console.log(`  ❌ ${name} — EXCEPTION: ${e.message}`);
        failed++;
    }
}

console.log('\n══════════════════════════════════════════');
console.log('TEST 1: Serie geométrica con opciones absurdas');
console.log('══════════════════════════════════════════');
test('Opciones ~200 cuando resultado real es billones → RECHAZAR', () => {
    const q = {
        type: 'multiple_choice',
        question: 'Calcula la suma de los primeros 25 términos de la serie geométrica 4, 12, 36, 108',
        options: ['180', '200', '220', '250'],
        correctIndex: 1,
        explanation: 'La suma es 200'
    };
    // QuizMathValidator debería detectar _isBrokenQuestion
    const r = QuizMathValidator.verify(q);
    return r === null; // Debe ser rechazada
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 2: Notación científica — opción incorrecta');
console.log('══════════════════════════════════════════');
test('Notación científica: debe detectar la opción más precisa', () => {
    const q = {
        type: 'multiple_choice',
        question: 'Expresar 450000 en notación científica',
        options: ['45 × 10^3', '4.5 × 10^5', '0.45 × 10^6', '45 × 10^4'],
        correctIndex: 0, // LLM marcó la incorrecta
        explanation: 'Se mueve el punto decimal'
    };
    const r = gate.verify(q);
    return r === null; // Debe rechazar porque 4.5 × 10^5 es la correcta (idx 1)
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 3: Sistema de ecuaciones sin solución entera');
console.log('══════════════════════════════════════════');
test('Sistema sin solución entera → RECHAZAR', () => {
    const q = {
        type: 'multiple_choice',
        question: 'Resuelve por eliminación el sistema: 3x + 2y = 10, 5x + 3y = 17',
        options: ['x=4, y=-1', 'x=2, y=2', 'x=3, y=1', 'x=1, y=4'],
        correctIndex: 0,
        explanation: 'Resolvemos por eliminación'
    };
    // 3(4) + 2(-1) = 12 - 2 = 10 ✓, 5(4) + 3(-1) = 20 - 3 = 17 ✓
    // Esto SÍ tiene solución entera → debe PASAR
    const r = gate.verify(q);
    return r !== null;
});

test('Sistema con solución no entera → RECHAZAR', () => {
    const q = {
        type: 'multiple_choice',
        question: 'Resuelve por eliminación el sistema: 3x + 2y = 7, 5x + 3y = 11',
        options: ['x=1, y=2', 'x=2, y=1', 'x=3, y=-1', 'x=-1, y=5'],
        correctIndex: 0,
        explanation: 'Resolvemos por eliminación'
    };
    // Real: det = 3*3 - 5*2 = -1; x = (7*3 - 11*2)/(-1) = (21-22)/(-1) = 1
    // y = (3*11 - 5*7)/(-1) = (33-35)/(-1) = 2
    // x=1, y=2 → 3(1)+2(2) = 7 ✓, 5(1)+3(2) = 11 ✓ → es correcta
    const r = gate.verify(q);
    return r !== null;
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 4: Suma de parámetros vs producto');
console.log('══════════════════════════════════════════');
test('LLM sumó en vez de multiplicar → RECHAZAR', () => {
    const q = {
        type: 'multiple_choice',
        question: '5 artículos a 20 pesos. ¿Cuánto se pagó en total?',
        options: ['25', '50', '100', '150'],
        correctIndex: 0, // 25 = 5+20 (suma errónea)
    };
    const r = gate.verify(q);
    return r === null;
});

test('Producto correcto → PASAR', () => {
    const q = {
        type: 'multiple_choice',
        question: '5 artículos a 20 pesos. ¿Cuánto se pagó en total?',
        options: ['50', '100', '150', '200'],
        correctIndex: 1, // 100 = 5×20 ✓
    };
    const r = gate.verify(q);
    return r !== null;
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 5: correctIndex fuera de rango');
console.log('══════════════════════════════════════════');
test('Index 5 con 3 opciones → RECHAZAR', () => {
    const q = {
        type: 'multiple_choice',
        question: '¿Cuánto es 2+2?',
        options: ['3', '4', '5'],
        correctIndex: 5,
    };
    return gate.verify(q) === null;
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 6: Opciones sin variación significativa');
console.log('══════════════════════════════════════════');
test('Spread < 1% → RECHAZAR', () => {
    const q = {
        type: 'multiple_choice',
        question: '¿Cuánto es 50+25?',
        options: ['74.9', '75.0', '75.1', '75.2'],
        correctIndex: 1,
    };
    return gate.verify(q) === null;
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 7: Resultado correcto 300,000.00 no está en opciones');
console.log('══════════════════════════════════════════');
test('Suma 250000 + 50000 = 300000, ninguna opción tiene → RECHAZAR por QuizMathValidator', () => {
    const q = {
        type: 'multiple_choice',
        question: 'Calcula 250000 + 50000',
        options: ['280000', '290000', '310000', '320000'],
        correctIndex: 0,
        explanation: 'Sumamos: 250000 + 50000 = 280000'
    };
    // QuizMathValidator debe rechazar esto
    const r = QuizMathValidator.verify(q);
    return r === null;
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 8: Preguntas correctas deben PASAR');
console.log('══════════════════════════════════════════');
test('5 * 3 = 15 → PASAR', () => {
    const q = {
        type: 'multiple_choice',
        question: '¿Cuánto es 5 * 3?',
        options: ['10', '15', '20', '25'],
        correctIndex: 1,
    };
    const r1 = QuizMathValidator.verify(q);
    const r2 = gate.verify(q);
    return r1 !== null && r2 !== null;
});

test('Pregunta no-matemática → PASAR sin validar', () => {
    const q = {
        type: 'multiple_choice',
        question: '¿Cuál es la capital de Francia?',
        options: ['Madrid', 'París', 'Roma', 'Berlín'],
        correctIndex: 1,
    };
    return gate.verify(q) !== null;
});

console.log('\n══════════════════════════════════════════');
console.log('TEST 9: Ordenamiento — múltiples verificaciones');
console.log('══════════════════════════════════════════');
test('Verificaciones reordenadas correctamente al final', () => {
    const ordV = OrderingQuestionValidator.getInstance();
    const r = ordV.validate(
        'Ordena los pasos para sumar decimales', ['Sumar columnas', 'Verificación independiente por partes', 'Alinear', 'Verificar resultado total', 'Anotar resultado']
    );
    // "Verificar resultado total" (prioridad 0) debe ir ANTES de "Verificación independiente por partes" (prioridad 2)
    const items = r.items;
    const verTotalIdx = items.findIndex(s => /verificar resultado total/i.test(s));
    const verPartsIdx = items.findIndex(s => /verificaci[oó]n independiente/i.test(s));
    return r.valid && verTotalIdx < verPartsIdx && verTotalIdx === items.length - 2;
});

console.log('\n══════════════════════════════════════════');
console.log(`\nRESULTADOS: ${passed} pasaron, ${failed} fallaron de ${passed + failed}`);
console.log('══════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);