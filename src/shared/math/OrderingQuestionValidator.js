/**
 * OrderingQuestionValidator — Validación semántica de preguntas de ordenamiento.
 *
 * Problema: Los LLMs generan preguntas de ordenamiento con errores procedurales:
 *   - Poner "escribir la coma decimal" como paso independiente cuando es parte de la alineación
 *   - Insertar pasos redundantes (consecuencias de otro paso) en medio del procedimiento
 *   - Colocar verificación en el medio en lugar del final
 *
 * Este validador detecta y corrige esos errores ANTES del shuffle.
 *
 * Principios SOLID:
 *   - SRP: Cada regla maneja exactamente un tipo de validación
 *   - OCP: Nuevas reglas se agregan creando clases, sin modificar las existentes
 *   - LSP: Todas las reglas implementan la misma interfaz { applies(), apply() }
 *   - ISP: Las reglas solo dependen de (question, items)
 *   - DIP: El validador depende de abstracciones (interfaz de regla), no de implementaciones
 */

// ═══════════════════════════════════════════════════════════════════════════
// Regla 1: DecimalCommaRule
// ═══════════════════════════════════════════════════════════════════════════
//
// En aritmética con decimales, la posición de la coma decimal se determina
// durante la alineación (paso 1), NO como paso independiente.
// Detecta cuando "escribir/colocar la coma decimal" aparece como paso
// separado y lo fusiona con el paso de alineación.
// ═══════════════════════════════════════════════════════════════════════════

class DecimalCommaRule {
    /** Patrones en la pregunta que indican contexto de aritmética decimal */
    static DECIMAL_QUESTION_PATTERNS = [
        /(?:suma|resta|sumar|restar|operaci[oó]n|adici[oó]n|multiplicaci[oó]n).*(?:decimal|decimales)/i,
        /(?:decimal|decimales).*(?:suma|resta|sumar|restar|operaci[oó]n)/i,
        /n[uú]meros?\s+(?:con\s+)?decimal/i,
        /coma\s+decimal/i,
        /punto\s+decimal/i,
        /\d+[.,]\d+\s*[+\-×÷]\s*\d+[.,]\d+/,
    ];

    /** Patrones de un paso que SOLO habla de colocar la coma decimal */
    static DECIMAL_STEP_PATTERNS = [
        /^(?:escribir|colocar|bajar|poner|anotar|marcar|ubicar|situar|posicionar|descender)\s+(?:la\s+)?(?:coma|punto)\s+decimal/i,
        /^(?:la\s+)?(?:coma|punto)\s+decimal\s+(?:se\s+)?(?:coloca|escribe|baja|pone|anota|marca|ubica)/i,
        /(?:coma|punto)\s+decimal\s+(?:en\s+)?(?:el\s+)?resultado/i,
        /^(?:descender|bajar)\s+(?:la\s+)?(?:coma|punto)/i,
        /^(?:trasladar|transferir)\s+(?:la\s+)?(?:coma|punto)\s+decimal/i,
    ];

    /** Patrones de un paso de alineación */
    static ALIGN_STEP_PATTERNS = [
        /aline(?:ar|ación|amos|a\s+los|amiento)/i,
        /colocar\s+(?:los\s+)?n[uú]meros?\s+(?:en\s+)?columna/i,
        /organizar\s+(?:los\s+)?n[uú]meros?\s+(?:vertical|en\s+columna)/i,
        /disponer\s+(?:los\s+)?n[uú]meros?\s+(?:vertical|en\s+columna)/i,
        /(?:escribir|colocar).*(?:uno\s+debajo|vertical)/i,
    ];

    /** @returns {boolean} */
    applies(question, items) {
        const qMatches = DecimalCommaRule.DECIMAL_QUESTION_PATTERNS.some(p => p.test(question));
        const hasDecimalStep = items.some(item =>
            DecimalCommaRule.DECIMAL_STEP_PATTERNS.some(p => p.test(item))
        );
        return qMatches || hasDecimalStep;
    }

    /**
     * @param {string} question
     * @param {string[]} items - Items en orden "correcto" según el LLM
     * @returns {{ modified: boolean, items?: string[], reason?: string, reject?: boolean }}
     */
    apply(question, items) {
        const decimalIdx = items.findIndex(item =>
            DecimalCommaRule.DECIMAL_STEP_PATTERNS.some(p => p.test(item))
        );

        if (decimalIdx === -1) return { modified: false };

        const alignIdx = items.findIndex(item =>
            DecimalCommaRule.ALIGN_STEP_PATTERNS.some(p => p.test(item))
        );

        // Caso A: No hay paso de alineación explícito → el paso de coma decimal
        // actúa como alineación. Debe estar en posición 0.
        if (alignIdx === -1) {
            if (decimalIdx === 0) return { modified: false };
            const fixed = [...items];
            const [step] = fixed.splice(decimalIdx, 1);
            fixed.unshift(step);
            return {
                modified: true,
                items: fixed,
                reason: 'Coma decimal movida al inicio (actúa como paso de alineación)',
            };
        }

        // Caso B: Ambos existen como el MISMO paso → nada que hacer
        if (decimalIdx === alignIdx) return { modified: false };

        // Caso C: Ambos existen como pasos SEPARADOS → fusionar
        // La coma decimal es una CONSECUENCIA de la alineación, no un paso independiente.
        const alignText = items[alignIdx];
        const decimalText = items[decimalIdx];

        // Construir texto fusionado
        const mergedText = alignText.replace(/\.?\s*$/, '') +
            ' y marcar la posición de la coma decimal en el resultado';

        // Eliminar el paso redundante de coma decimal
        const fixed = items.filter((_, i) => i !== decimalIdx);

        // Encontrar el nuevo índice del paso de alineación (puede haber cambiado)
        const newAlignIdx = alignIdx > decimalIdx ? alignIdx - 1 : alignIdx;
        fixed[newAlignIdx] = mergedText;

        console.warn(
            `⚠️ [OrderingValidator] CORREGIDO: Paso redundante "${decimalText}" ` +
            `fusionado con "${alignText}" → "${mergedText}"`
        );

        return {
            modified: true,
            items: fixed,
            reason: `Paso redundante fusionado: "${decimalText}" es consecuencia de la alineación`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 2: AlignmentFirstRule
// ═══════════════════════════════════════════════════════════════════════════
//
// En procedimientos aritméticos, la alineación de números SIEMPRE es el
// primer paso. Si el LLM la puso en otra posición, moverla al inicio.
// ═══════════════════════════════════════════════════════════════════════════

class AlignmentFirstRule {
    static ARITHMETIC_QUESTION = /(?:pasos|procedimiento|proceso|orden).*(?:suma|resta|multiplica|divide|operaci[oó]n|c[aá]lculo)/i;

    static ALIGN_PATTERNS = [
        /^aline(?:ar|ación|amos|a\s+los|amiento)/i,
        /^colocar\s+(?:los\s+)?n[uú]meros?\s+(?:en\s+)?columna/i,
        /^organizar\s+(?:los\s+)?n[uú]meros?\s+(?:vertical|en\s+columna)/i,
        /^disponer\s+(?:los\s+)?n[uú]meros/i,
        /^(?:escribir|colocar).*(?:uno\s+debajo|vertical)/i,
    ];

    /** Pasos que son prerequisitos de la alineación — si alguno aparece
     *  ANTES de la alineación, NO se debe mover la alineación al inicio. */
    static PREREQUISITE_PATTERNS = [
        /convertir\s+(?:a|en)\s*(?:forma\s+)?decimal/i,
        /(?:pasar|transformar|expresar|cambiar)\s+(?:a|en)\s*(?:forma\s+)?decimal/i,
        /(?:expandir|desarrollar)\s+(?:la\s+)?notaci[oó]n\s+cient[ií]fica/i,
        /notaci[oó]n\s+cient[ií]fica\s+a\s+(?:forma\s+)?(?:decimal|est[aá]ndar)/i,
        /(?:forma|notaci[oó]n)\s+est[aá]ndar/i,
        /convertir\s+(?:las?\s+)?fracci[oó]n/i,
        /fracci[oó]n\s+a\s+decimal/i,
    ];

    applies(question, items) {
        return AlignmentFirstRule.ARITHMETIC_QUESTION.test(question) &&
            items.some(item => AlignmentFirstRule.ALIGN_PATTERNS.some(p => p.test(item)));
    }

    apply(question, items) {
        const alignIdx = items.findIndex(item =>
            AlignmentFirstRule.ALIGN_PATTERNS.some(p => p.test(item))
        );

        if (alignIdx <= 0) return { modified: false }; // Already first or not found

        // Check if there's a prerequisite step BEFORE the alignment —
        // if so, don't move alignment to position 0 (the dependency is correct).
        const hasPrereqBefore = items.slice(0, alignIdx).some(item =>
            AlignmentFirstRule.PREREQUISITE_PATTERNS.some(p => p.test(item))
        );
        if (hasPrereqBefore) return { modified: false };

        const fixed = [...items];
        const [step] = fixed.splice(alignIdx, 1);
        fixed.unshift(step);

        return {
            modified: true,
            items: fixed,
            reason: `Paso de alineación movido al inicio (estaba en posición ${alignIdx + 1})`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 3: VerificationLastRule
// ═══════════════════════════════════════════════════════════════════════════
//
// Pasos de verificación/comprobación siempre deben ser el ÚLTIMO paso.
// Si el LLM los insertó en medio del procedimiento, moverlos al final.
// ═══════════════════════════════════════════════════════════════════════════

class VerificationLastRule {
    static VERIFY_PATTERNS = [
        /^verificar/i,
        /^comprobar/i,
        /^revisar\s+(?:el\s+)?resultado/i,
        /^confirmar\s+(?:el\s+)?resultado/i,
        /^validar\s+(?:el\s+)?resultado/i,
        /^hacer\s+(?:la\s+)?(?:prueba|verificaci[oó]n)/i,
        /^(?:la\s+)?prueba\s+(?:de\s+)?(?:verificaci[oó]n|resta|suma)/i,
        /verificaci[oó]n\s+(?:independiente|por\s+partes|parcial|final|general|global|del\s+resultado)/i,
    ];

    /**
     * Verificaciones que son PREREQUISITOS (deben ir ANTES de calcular, NO al final).
     * Ejemplo: "Verificar convergencia" debe hacerse antes de aplicar la fórmula de la serie.
     */
    static PRECALCULATION_VERIFY_PATTERNS = [
        /(?:verificar|comprobar)\s+(?:la\s+)?convergencia/i,
        /(?:verificar|comprobar)\s+(?:si|que)\s+(?:la\s+)?(?:serie|sucesi[oó]n)\s+converge/i,
        /convergencia.*\|r\|/i,
        /\|r\|\s*<\s*1/i,
        /(?:verificar|comprobar)\s+(?:(?:que|si)\s+)?(?:las?\s+)?dimension/i,
        /(?:verificar|comprobar)\s+(?:(?:que|si)\s+)?(?:la\s+)?compatibilidad/i,
        /(?:verificar|comprobar)\s+(?:las?\s+)?(?:condiciones?\s+(?:de\s+)?)?(?:existencia|aplicabilidad)/i,
        /(?:verificar|comprobar)\s+(?:el\s+)?(?:tipo|rango|dominio)/i,
        /(?:verificar|comprobar)\s+(?:que|si)\s+(?:las?\s+)?matrices?\s+(?:son|sean)\s+(?:compatib|del\s+mismo)/i,
        /(?:verificar|comprobar)\s+(?:que|si)\s+(?:las?\s+)?matrices?\s+(?:tienen|tengan)\s+(?:las?\s+)?mismas?\s+dimension/i,
        /(?:verificar|comprobar)\s+(?:el\s+)?requisito/i,
        /(?:verificar|comprobar)\s+(?:que|si)\s+(?:se\s+)?(?:puede|pueden)\s+(?:sumar|restar|multiplicar|operar)/i,
        /(?:verificar|comprobar)\s+(?:la\s+)?(?:condici[oó]n|hip[oó]tesis)\s+(?:de|del|para)/i,
        /(?:verificar|comprobar)\s+(?:(?:que|si)\s+)?(?:las?\s+)?(?:dimensiones|medidas)\s+(?:sean|son|coincid|igual)/i,
        /(?:verificar|comprobar)\s+(?:(?:que|si)\s+)?(?:el\s+)?(?:orden|tama[ñn]o)\s+(?:de\s+)?(?:las?\s+)?matrices?/i,
        /dimension.*(?:compatib|igual|coincid|misma)/i,
        /compatib.*dimension/i,
    ];

    /**
     * Patrones para clasificar el TIPO de verificación y determinar el orden relativo.
     * Prioridad más baja = va primero entre los pasos de verificación.
     * "Verificar resultado total/general" va ANTES de "Verificación independiente por partes".
     */
    static VERIFY_PRIORITY = [
        { pattern: /(?:resultado\s+(?:total|final|general|global|completo))|(?:verificar\s+(?:el\s+)?(?:total|resultado))/i, priority: 0 },
        { pattern: /(?:comprobar|revisar|confirmar)\s+(?:el\s+)?resultado/i, priority: 1 },
        { pattern: /(?:independiente|por\s+partes|parcial)/i, priority: 2 },
        { pattern: /prueba\s+(?:de\s+)?(?:verificaci[oó]n|resta|suma)/i, priority: 3 },
    ];

    applies(question, items) {
        return items.some(item =>
            VerificationLastRule.VERIFY_PATTERNS.some(p => p.test(item))
        );
    }

    /**
     * Mueve TODOS los pasos de verificación al final, preservando su orden
     * relativo correcto (verificación total → verificación por partes).
     */
    apply(question, items) {
        // Encontrar pasos de verificación POST-cálculo (excluir pre-cálculo)
        const verifyIndices = [];
        for (let i = 0; i < items.length; i++) {
            if (VerificationLastRule.VERIFY_PATTERNS.some(p => p.test(items[i])) &&
                !VerificationLastRule.PRECALCULATION_VERIFY_PATTERNS.some(p => p.test(items[i]))) {
                verifyIndices.push(i);
            }
        }

        if (verifyIndices.length === 0) return { modified: false };

        // Si todos ya están al final y en orden, no modificar
        const totalItems = items.length;
        const expectedStart = totalItems - verifyIndices.length;
        const alreadyAtEnd = verifyIndices.every((idx, i) => idx === expectedStart + i);

        if (alreadyAtEnd && this._isCorrectlyOrdered(verifyIndices.map(i => items[i]))) {
            return { modified: false };
        }

        // Separar pasos de verificación de los demás
        const verifySteps = verifyIndices.map(i => items[i]);
        const nonVerifySteps = items.filter((_, i) => !verifyIndices.includes(i));

        // Ordenar pasos de verificación por prioridad semántica
        const sortedVerify = this._sortByPriority(verifySteps);

        const fixed = [...nonVerifySteps, ...sortedVerify];

        const reasons = verifyIndices.map((idx, i) =>
            `"${items[idx]}" (pos ${idx + 1} → ${nonVerifySteps.length + i + 1})`
        );

        console.warn(
            `⚠️ [OrderingValidator] CORREGIDO: ${verifyIndices.length} paso(s) de verificación ` +
            `movidos al final en orden correcto: ${sortedVerify.map(s => '"' + s.substring(0, 40) + '..."').join(' → ')}`
        );

        return {
            modified: true,
            items: fixed,
            reason: `${verifyIndices.length} paso(s) de verificación reordenados al final: ${reasons.join('; ')}`,
        };
    }

    /** Asigna prioridad numérica a un paso de verificación */
    _getPriority(step) {
        for (const { pattern, priority } of VerificationLastRule.VERIFY_PRIORITY) {
            if (pattern.test(step)) return priority;
        }
        return 10; // Prioridad por defecto (va al final entre verificaciones)
    }

    /** Ordena pasos de verificación por prioridad semántica */
    _sortByPriority(verifySteps) {
        return [...verifySteps].sort((a, b) => this._getPriority(a) - this._getPriority(b));
    }

    /** Verifica si los pasos ya están en orden correcto de prioridad */
    _isCorrectlyOrdered(verifySteps) {
        for (let i = 1; i < verifySteps.length; i++) {
            if (this._getPriority(verifySteps[i]) < this._getPriority(verifySteps[i - 1])) {
                return false;
            }
        }
        return true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 4: RedundantStepRule
// ═══════════════════════════════════════════════════════════════════════════
//
// Detecta pasos que son semánticamente redundantes — una consecuencia
// directa de otro paso que ya los cubre. Los fusiona o elimina.
//
// Ejemplo: "Sumar columnas de derecha a izquierda" ya implica
// "Escribir los resultados parciales" — no necesita paso separado.
// ═══════════════════════════════════════════════════════════════════════════

class RedundantStepRule {
    /**
     * Pares de (patrón padre, patrón consecuencia).
     * Si ambos existen como pasos separados, la consecuencia se fusiona con el padre.
     */
    static CONSEQUENCE_PAIRS = [
        {
            parent: /sumar?\s+(?:las\s+)?columnas?/i,
            consequence: /escribir\s+(?:los\s+)?resultados?\s+parcial/i,
            mergeText: ' y anotar resultados parciales',
        },
        {
            parent: /sumar?\s+(?:las\s+)?columnas?/i,
            consequence: /llevar?\s+(?:el\s+)?acarreo/i,
            // No fusionar: acarreo es un paso legítimo separado
            skipMerge: true,
        },
        {
            parent: /aline(?:ar|ación)/i,
            consequence: /(?:igualar|completar|rellenar|agregar)\s+(?:con\s+)?ceros/i,
            mergeText: ' (completando con ceros las posiciones faltantes)',
        },
        {
            parent: /(?:obtener|escribir|anotar)\s+(?:el\s+)?resultado\s+(?:final|completo|total)/i,
            consequence: /(?:juntar|unir|combinar)\s+(?:los\s+)?(?:resultados?|sumas?)\s+parcial/i,
            mergeText: ' combinando los resultados parciales',
        },
    ];

    applies(question, items) {
        return items.length >= 4; // Only worth checking with enough steps
    }

    apply(question, items) {
        let currentItems = [...items];
        let wasModified = false;
        const reasons = [];

        for (const pair of RedundantStepRule.CONSEQUENCE_PAIRS) {
            if (pair.skipMerge) continue;

            const parentIdx = currentItems.findIndex(item => pair.parent.test(item));
            const consequenceIdx = currentItems.findIndex(item => pair.consequence.test(item));

            if (parentIdx === -1 || consequenceIdx === -1 || parentIdx === consequenceIdx) continue;

            // Fusionar consecuencia en el padre
            const parentText = currentItems[parentIdx];
            const consequenceText = currentItems[consequenceIdx];

            currentItems[parentIdx] = parentText.replace(/\.?\s*$/, '') + pair.mergeText;
            currentItems = currentItems.filter((_, i) => i !== consequenceIdx);

            wasModified = true;
            reasons.push(`"${consequenceText}" fusionado con "${parentText}"`);

            console.warn(
                `⚠️ [OrderingValidator] Paso redundante eliminado: "${consequenceText}" ` +
                `es consecuencia de "${parentText}"`
            );
        }

        if (!wasModified) return { modified: false };

        return {
            modified: true,
            items: currentItems,
            reason: reasons.join('; '),
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 5: StepCountConsistencyRule
// ═══════════════════════════════════════════════════════════════════════════
//
// Rechaza preguntas donde la pregunta misma dice "ordena los N pasos"
// pero la cantidad de items es diferente a N.
// ═══════════════════════════════════════════════════════════════════════════

class StepCountConsistencyRule {
    static COUNT_PATTERN = /(?:ordena|organiza|pon\s+en\s+orden)\s+(?:los|las|estos|estas)\s+(\d+)\s+(?:pasos|etapas|fases|elementos)/i;

    applies(question, items) {
        return StepCountConsistencyRule.COUNT_PATTERN.test(question);
    }

    apply(question, items) {
        const match = question.match(StepCountConsistencyRule.COUNT_PATTERN);
        if (!match) return { modified: false };

        const claimed = parseInt(match[1], 10);
        if (claimed === items.length) return { modified: false };

        // Si la diferencia es de 1 (por fusión de esta validación), actualizar es aceptable
        if (Math.abs(claimed - items.length) <= 1) return { modified: false };

        // Discrepancia significativa → rechazar
        return {
            reject: true,
            reason: `La pregunta dice "${claimed} pasos" pero hay ${items.length} items`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 6: ArithmeticProcedureOrderRule
// ═══════════════════════════════════════════════════════════════════════════
//
// En aritmética con acarreos (suma/resta de varios dígitos), los acarreos
// ocurren SIMULTÁNEAMENTE con la suma de cada columna y ANTES de pasar
// a la siguiente columna hacia la izquierda.
//
// Orden correcto:
//   Operar columna → Llevar acarreo (si ≥10) → Continuar siguiente columna
//
// Este es el bug reportado:
//   LLM genera: [Alinear, Sumar, CONTINUAR SUMANDO, llevar acarreos, Resultado]
//   Correcto:   [Alinear, Sumar, LLEVAR ACARREOS, continuar sumando, Resultado]
// ═══════════════════════════════════════════════════════════════════════════

class ArithmeticProcedureOrderRule {
    /** Patrones que identifican el paso de llevar/registrar acarreos */
    static CARRY_PATTERNS = [
        /^llevar\s+(?:el\s+)?acarreo/i,
        /^registrar\s+(?:el\s+)?acarreo/i,
        /^anotar\s+(?:el\s+)?acarreo/i,
        /^escribir\s+(?:el\s+)?acarreo/i,
        /^(?:el\s+)?acarreo\s+(?:se\s+)?(?:lleva|registra|anota|escribe)/i,
        /^(?:aplicar|usar|considerar)\s+(?:el\s+)?acarreo/i,
        /acarreos?\s+(?:a\s+la\s+)?(?:siguiente|pr[oó]xima)\s+columna/i,
        /\bacarreos?\s+pendientes?\b/i,
    ];

    /** Patrones que identifican "continuar/pasar a la siguiente columna" */
    static CONTINUE_PATTERNS = [
        /^continuar\s+sumando/i,
        /^continuar\s+restando/i,
        /^continuar\s+(?:con\s+)?(?:la\s+)?(?:siguiente|pr[oó]xima)\s+columna/i,
        /^seguir\s+sumando/i,
        /^seguir\s+restando/i,
        /^repetir\s+(?:el\s+)?(?:proceso|procedimiento|paso|pasos)\s+(?:para\s+)?(?:las\s+)?(?:otras|dem[aá]s|siguientes?)\s+columnas?/i,
        /^pasar\s+a\s+la\s+(?:siguiente|pr[oó]xima)\s+columna/i,
        /^(?:avanzar|moverse?|desplazarse?)\s+(?:a\s+)?(?:la\s+)?(?:siguiente|pr[oó]xima)\s+columna/i,
        /^mover\s+a\s+la\s+(?:siguiente|pr[oó]xima)\s+columna/i,
    ];

    /** Patrones de contexto aritmético donde aplica esta regla */
    static ARITHMETIC_CONTEXT_PATTERNS = [
        /suma|adici[oó]n|a[ñn]adiendo/i,
        /resta|sustracci[oó]n/i,
        /acarreo/i,
        /columna/i,
        /d[ií]gito/i,
    ];

    applies(question, items) {
        // Necesita al menos un paso de acarreo Y un paso de "continuar"
        const hasCarry    = items.some(item => ArithmeticProcedureOrderRule.CARRY_PATTERNS.some(p => p.test(item)));
        const hasContinue = items.some(item => ArithmeticProcedureOrderRule.CONTINUE_PATTERNS.some(p => p.test(item)));
        if (!hasCarry || !hasContinue) return false;

        // Verificar contexto aritmético (pregunta o items)
        const context = question + ' ' + items.join(' ');
        return ArithmeticProcedureOrderRule.ARITHMETIC_CONTEXT_PATTERNS.some(p => p.test(context));
    }

    apply(question, items) {
        const carryIdx    = items.findIndex(item => ArithmeticProcedureOrderRule.CARRY_PATTERNS.some(p => p.test(item)));
        const continueIdx = items.findIndex(item => ArithmeticProcedureOrderRule.CONTINUE_PATTERNS.some(p => p.test(item)));

        if (carryIdx === -1 || continueIdx === -1) return { modified: false };

        // Si acarreo ya está ANTES de continuar, el orden es correcto
        if (carryIdx < continueIdx) return { modified: false };

        // Corrección: intercambiar posiciones
        const fixed = [...items];
        [fixed[carryIdx], fixed[continueIdx]] = [fixed[continueIdx], fixed[carryIdx]];

        console.warn(
            `⚠️ [OrderingValidator] CORREGIDO (ArithmeticProcedureOrderRule): ` +
            `"${items[continueIdx]}" (pos ${continueIdx + 1}) estaba ANTES de ` +
            `"${items[carryIdx]}" (pos ${carryIdx + 1}). ` +
            `Los acarreos ocurren ANTES de pasar a la siguiente columna.`
        );

        return {
            modified: true,
            items: fixed,
            reason: `"${items[carryIdx]}" (llevar acarreos) debe ir en pos ${continueIdx + 1} antes que ` +
                    `"${items[continueIdx]}" (continuar sumando). Los acarreos se registran al operar cada columna, ANTES de pasar a la siguiente.`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 7: WriteResultLastRule
// ═══════════════════════════════════════════════════════════════════════════
//
// En cualquier procedimiento matemático, el paso de ESCRIBIR/ANOTAR el
// resultado final siempre debe ser el ÚLTIMO paso antes de la verificación.
// Si el LLM lo insertó en medio del procedimiento, moverlo al final
// (pero antes de los pasos de verificación).
// ═══════════════════════════════════════════════════════════════════════════

class WriteResultLastRule {
    static WRITE_RESULT_PATTERNS = [
        /^escribir\s+(?:el\s+)?resultado\s+final/i,
        /^anotar\s+(?:el\s+)?resultado\s+final/i,
        /^registrar\s+(?:el\s+)?resultado\s+final/i,
        /^colocar\s+(?:el\s+)?resultado\s+final/i,
        /^(?:el\s+)?resultado\s+final\s+(?:es|ser[aá]|queda)/i,
        /^(?:obtener|calcular)\s+(?:el\s+)?resultado\s+final/i,
    ];

    /** Resultados intermedios que NO deben moverse al final */
    static PROVISIONAL_RESULT_PATTERNS = [
        /resultado\s+provisional/i,
        /resultado\s+parcial/i,
        /resultado\s+intermedio/i,
        /resultado\s+con\s+todos?\s+(?:los\s+)?decimales/i,
        /resultado\s+sin\s+redonde/i,
        /resultado\s+antes?\s+(?:de\s+)?redonde/i,
    ];

    static VERIFY_PATTERNS = [
        /^verificar/i,
        /^comprobar/i,
        /^revisar\s+(?:el\s+)?resultado/i,
        /^confirmar\s+(?:el\s+)?resultado/i,
        /verificaci[oó]n/i,
    ];

    applies(question, items) {
        return items.some(item =>
            WriteResultLastRule.WRITE_RESULT_PATTERNS.some(p => p.test(item)) &&
            !WriteResultLastRule.PROVISIONAL_RESULT_PATTERNS.some(p => p.test(item))
        );
    }

    apply(question, items) {
        const resultIdx = items.findIndex(item =>
            WriteResultLastRule.WRITE_RESULT_PATTERNS.some(p => p.test(item)) &&
            !WriteResultLastRule.PROVISIONAL_RESULT_PATTERNS.some(p => p.test(item))
        );
        if (resultIdx === -1) return { modified: false };

        // Find the first POST-CALCULATION verification step (exclude pre-calculation)
        const firstVerifyIdx = items.findIndex(item =>
            WriteResultLastRule.VERIFY_PATTERNS.some(p => p.test(item)) &&
            !VerificationLastRule.PRECALCULATION_VERIFY_PATTERNS.some(p => p.test(item))
        );

        // Only act when "escribir resultado" appears AFTER a verification step
        // (verification should already be at the end from VerificationLastRule)
        if (firstVerifyIdx === -1 || resultIdx < firstVerifyIdx) return { modified: false };

        // Move result to just BEFORE the first verification step
        const fixed = [...items];
        const [step] = fixed.splice(resultIdx, 1);
        // firstVerifyIdx is now one position earlier since we removed an element before it
        const insertAt = resultIdx > firstVerifyIdx ? firstVerifyIdx : firstVerifyIdx - 1;
        fixed.splice(insertAt, 0, step);

        console.warn(
            `⚠️ [OrderingValidator] CORREGIDO (WriteResultLastRule): ` +
            `"${items[resultIdx]}" (pos ${resultIdx + 1}) movido antes de verificación (pos ${firstVerifyIdx + 1})`
        );

        return {
            modified: true,
            items: fixed,
            reason: `"${items[resultIdx]}" movido antes de la verificación (el resultado se escribe antes de comprobar)`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 8: OperationBeforeResultRule
// ═══════════════════════════════════════════════════════════════════════════
//
// En procedimientos de suma/resta con múltiples columnas, el resultado
// se obtiene DESPUÉS de operar TODAS las columnas. Detecta cuando el
// paso de "obtener resultado" está entre pasos de operación.
// ═══════════════════════════════════════════════════════════════════════════

class OperationBeforeResultRule {
    static OPERATION_PATTERNS = [
        /^sumar\s+(?:la\s+)?(?:primera|segunda|tercera|siguiente|cada)\s+columna/i,
        /^sumar\s+(?:las\s+)?d[ií]gitos?\s+de/i,
        /^multiplicar\s+por/i,
        /^realizar\s+(?:la\s+)?(?:multiplicaci[oó]n|divisi[oó]n|suma|operaci[oó]n)/i,
        /^operar\s+(?:cada|la[s]?)\s+columna/i,
    ];

    static RESULT_PATTERNS = [
        /^(?:escribir|anotar|registrar|poner)\s+(?:el\s+)?resultado/i,
        /^(?:el\s+)?resultado\s+(?:final|es|de\s+la\s+operaci[oó]n)/i,
    ];

    applies(question, items) {
        const hasOp     = items.some(item => OperationBeforeResultRule.OPERATION_PATTERNS.some(p => p.test(item)));
        const hasResult = items.some(item => OperationBeforeResultRule.RESULT_PATTERNS.some(p => p.test(item)));
        return hasOp && hasResult;
    }

    apply(question, items) {
        // Verificar que el resultado venga DESPUÉS de todas las operaciones
        const resultIdx = items.findIndex(item =>
            OperationBeforeResultRule.RESULT_PATTERNS.some(p => p.test(item))
        );
        if (resultIdx === -1) return { modified: false };

        // Buscar si hay alguna operación DESPUÉS del resultado
        const laterOpIdx = items.findIndex((item, i) =>
            i > resultIdx && OperationBeforeResultRule.OPERATION_PATTERNS.some(p => p.test(item))
        );
        if (laterOpIdx === -1) return { modified: false }; // Ok: resultado después de todas las ops

        // El resultado está antes de una operación — mover resultado al final de las operaciones
        const lastOpIdx = [...items].reduce((last, item, i) => {
            return OperationBeforeResultRule.OPERATION_PATTERNS.some(p => p.test(item)) ? i : last;
        }, -1);

        if (lastOpIdx <= resultIdx) return { modified: false };

        const fixed = [...items];
        const [step] = fixed.splice(resultIdx, 1);
        // Insertar después del último paso de operación (índice decrementó por el splice)
        const insertAt = lastOpIdx; // Ya ajustado porque eliminamos un elemento antes de lastOpIdx
        fixed.splice(insertAt, 0, step);

        return {
            modified: true,
            items: fixed,
            reason: `"${items[resultIdx]}" movido después de "${items[lastOpIdx]}" (resultado va tras la última operación)`,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regla 9: StepDependencyOrderRule
// ═══════════════════════════════════════════════════════════════════════════
//
// Regla genérica de DEPENDENCIAS LÓGICAS entre pasos.
//
// Principio: "No puedes ejecutar un paso que depende del resultado de otro
// paso que aún no se ha realizado."
//
// Ejemplo clásico: notación científica
//   ❌ Incorrecto: [Alinear decimales, Convertir a decimal, Sumar]
//   ✅ Correcto:   [Convertir a decimal, Alinear decimales, Sumar]
//   Razón: Alinear decimales REQUIERE que los números ya estén en decimal.
//
// La regla define pares (prerequisito → dependiente) con patrones.
// Si el dependiente aparece ANTES del prerequisito, los intercambia.
// ═══════════════════════════════════════════════════════════════════════════

class StepDependencyOrderRule {
    /**
     * Cada entrada define: un paso prerequisito y un paso que DEPENDE de él.
     * Si el dependiente está antes del prerequisito, se reordena.
     *
     * contextPatterns (opcional): patrones en la pregunta o en los items que
     * indican que esta dependencia aplica. Si se omite, aplica siempre que
     * se detecten ambos patrones en los items.
     */
    static DEPENDENCY_PAIRS = [
        // ── Notación científica: convertir ANTES de alinear ──────────────
        {
            prerequisite: [
                /convertir\s+(?:a|en|los?\s+n[uú]meros?\s+(?:a|en))?\s*(?:forma\s+)?decimal/i,
                /(?:pasar|transformar|expresar|cambiar)\s+(?:a|en)\s*(?:forma\s+)?decimal/i,
                /(?:expandir|desarrollar)\s+(?:la\s+)?notaci[oó]n\s+cient[ií]fica/i,
                /(?:eliminar|quitar|remover)\s+(?:la\s+)?notaci[oó]n\s+cient[ií]fica/i,
                /notaci[oó]n\s+cient[ií]fica\s+a\s+(?:forma\s+)?(?:decimal|est[aá]ndar|normal)/i,
                /(?:forma|notaci[oó]n)\s+est[aá]ndar/i,
            ],
            dependent: [
                /aline(?:ar|aci[oó]n)\s+(?:(?:los?\s+)?(?:puntos?\s+)?decimal|(?:por\s+)?(?:el\s+)?(?:punto|coma)\s+decimal)/i,
                /alinear\s+(?:los\s+)?n[uú]meros?\s+(?:por|seg[uú]n)\s+(?:el\s+)?(?:punto|coma)/i,
                /(?:colocar|poner|escribir)\s+(?:los\s+)?n[uú]meros?\s+(?:en\s+)?columna/i,
            ],
            contextPatterns: [
                /notaci[oó]n\s+cient[ií]fica/i,
                /\d+\.?\d*\s*[×x]\s*10\s*\^/i,
                /\d+\.?\d*[eE]\d+/i,
            ],
            reason: 'Convertir a decimal ANTES de alinear (no se puede alinear notación científica)',
        },
        // ── Fracciones: convertir a decimal ANTES de operar con decimales ─
        {
            prerequisite: [
                /convertir\s+(?:las?\s+)?fracci[oó]n/i,
                /(?:pasar|transformar|expresar)\s+(?:las?\s+)?fracci[oó]n/i,
                /fracci[oó]n\s+a\s+decimal/i,
                /dividir\s+(?:el\s+)?numerador/i,
            ],
            dependent: [
                /aline(?:ar|aci[oó]n)\s+(?:(?:los?\s+)?(?:puntos?\s+)?decimal)/i,
                /sumar?\s+(?:los\s+)?(?:valores?\s+)?decimal/i,
                /operar\s+(?:con\s+)?(?:los\s+)?decimal/i,
            ],
            contextPatterns: [
                /fracci[oó]n|fracciones/i,
                /\d+\s*\/\s*\d+/,
            ],
            reason: 'Convertir fracciones a decimal ANTES de operar con decimales',
        },
        // ── Identificar datos ANTES de plantear ecuación ──────────────────
        {
            prerequisite: [
                /identificar\s+(?:los\s+)?(?:datos|variables|inc[oó]gnitas|valores)/i,
                /extraer\s+(?:los\s+)?(?:datos|valores|informaci[oó]n)/i,
                /leer\s+(?:el\s+)?(?:problema|enunciado)/i,
                /analizar\s+(?:el\s+)?(?:problema|enunciado)/i,
            ],
            dependent: [
                /plantear\s+(?:la\s+)?ecuaci[oó]n/i,
                /(?:escribir|formular|armar)\s+(?:la\s+)?ecuaci[oó]n/i,
                /(?:establecer|definir)\s+(?:la\s+)?(?:ecuaci[oó]n|f[oó]rmula|expresi[oó]n)/i,
            ],
            reason: 'Identificar datos ANTES de plantear la ecuación',
        },
        // ── Plantear ecuación ANTES de resolver/despejar ──────────────────
        {
            prerequisite: [
                /plantear\s+(?:la\s+)?ecuaci[oó]n/i,
                /(?:escribir|formular|armar)\s+(?:la\s+)?ecuaci[oó]n/i,
                /(?:establecer|definir)\s+(?:la\s+)?(?:ecuaci[oó]n|f[oó]rmula)/i,
            ],
            dependent: [
                /(?:resolver|despejar|simplificar)\s+(?:la\s+)?ecuaci[oó]n/i,
                /despejar\s+(?:la\s+)?(?:variable|inc[oó]gnita|x)/i,
                /sustituir\s+(?:en\s+)?(?:la\s+)?(?:ecuaci[oó]n|f[oó]rmula)/i,
            ],
            reason: 'Plantear ecuación ANTES de resolver/despejar',
        },
        // ── Derivar ANTES de igualar a cero/encontrar puntos críticos ─────
        {
            prerequisite: [
                /(?:calcular|obtener|hallar|encontrar)\s+(?:la\s+)?derivada/i,
                /derivar\s+(?:la\s+)?funci[oó]n/i,
                /(?:aplicar|usar)\s+(?:las?\s+)?(?:reglas?\s+de\s+)?derivaci[oó]n/i,
            ],
            dependent: [
                /igualar\s+(?:la\s+)?(?:derivada\s+)?(?:a\s+)?(?:cero|0)/i,
                /(?:encontrar|hallar|buscar)\s+(?:los?\s+)?(?:puntos?\s+)?cr[ií]tic/i,
                /(?:resolver|encontrar)\s+(?:f'|f\s*'\s*)\(?x\)?\s*=\s*0/i,
            ],
            contextPatterns: [
                /derivada/i,
                /extremo|m[ií]nimo|m[aá]ximo/i,
                /punto\s+cr[ií]tic/i,
            ],
            reason: 'Calcular derivada ANTES de igualar a cero',
        },
        // ── Factorizar/simplificar ANTES de encontrar raíces ──────────────
        {
            prerequisite: [
                /factorizar/i,
                /simplificar\s+(?:la\s+)?(?:expresi[oó]n|ecuaci[oó]n)/i,
            ],
            dependent: [
                /(?:encontrar|hallar|obtener)\s+(?:las?\s+)?ra[ií]ces?/i,
                /(?:encontrar|hallar|obtener)\s+(?:los?\s+)?(?:valores?\s+de\s+)?x/i,
            ],
            reason: 'Factorizar/simplificar ANTES de encontrar raíces',
        },
        // ── Sumar/operar ANTES de redondear ───────────────────────────────
        {
            prerequisite: [
                /(?:sumar|restar|multiplicar|dividir|operar|calcular)\s+(?:los?\s+)?/i,
                /(?:realizar|ejecutar|efectuar)\s+(?:la\s+)?(?:operaci[oó]n|suma|resta|multiplicaci[oó]n|divisi[oó]n)/i,
                /(?:obtener|calcular)\s+(?:el\s+)?(?:resultado|total|valor)/i,
            ],
            dependent: [
                /redonde(?:ar|o)\s+(?:(?:el\s+)?resultado|a\s+\d+\s+decimal)/i,
                /(?:aproximar|truncar)\s+(?:el\s+)?resultado/i,
            ],
            reason: 'Calcular resultado ANTES de redondear',
        },
        // ── Calcular cada serie ANTES de combinar resultados ──────────────
        {
            prerequisite: [
                /(?:calcular|resolver|obtener)\s+(?:la\s+)?(?:suma\s+(?:de\s+)?(?:la\s+)?)?serie\s+(?:aritm[eé]tica|geom[eé]trica)/i,
                /(?:aplicar|usar)\s+(?:la\s+)?f[oó]rmula\s+(?:de\s+)?(?:la\s+)?serie/i,
                /(?:sumar|calcular)\s+(?:la\s+)?(?:progresi[oó]n|sumatoria)/i,
            ],
            dependent: [
                /(?:sumar|combinar|agregar)\s+(?:los?\s+)?(?:resultados?|series?|valores?)/i,
                /(?:resultado|total)\s+(?:final|combinado|global)/i,
                /S\s*[₁1]\s*\+\s*S\s*[₂2]/i,
            ],
            reason: 'Calcular cada serie individualmente ANTES de combinar resultados',
        },
        // ── Verificar convergencia ANTES de aplicar fórmula de serie ──────
        {
            prerequisite: [
                /verificar\s+(?:la\s+)?convergencia/i,
                /comprobar\s+(?:la\s+)?convergencia/i,
                /verificar\s+(?:si|que)\s+(?:la\s+)?(?:serie|sucesi[oó]n)\s+converge/i,
                /(?:condici[oó]n|criterio)\s+(?:de\s+)?convergencia/i,
            ],
            dependent: [
                /aplicar\s+(?:la\s+)?f[oó]rmula/i,
                /calcular\s+(?:la\s+)?(?:suma\s+(?:de\s+)?(?:la\s+)?)?serie/i,
                /usar\s+(?:la\s+)?f[oó]rmula/i,
                /sumar\s+(?:los\s+)?t[eé]rminos/i,
                /(?:sustituir|reemplazar)\s+(?:en\s+)?(?:la\s+)?f[oó]rmula/i,
            ],
            contextPatterns: [
                /serie|sucesi[oó]n|progresi[oó]n|convergencia/i,
            ],
            reason: 'Verificar convergencia ANTES de aplicar la fórmula (no se puede usar la fórmula sin confirmar que la serie converge)',
        },
        // ── Verificar dimensiones ANTES de operar matrices ────────────────
        {
            prerequisite: [
                /verificar\s+(?:(?:que|si)\s+)?(?:las?\s+)?dimension/i,
                /comprobar\s+(?:(?:que|si)\s+)?(?:las?\s+)?dimension/i,
                /verificar\s+(?:(?:que|si)\s+)?(?:la\s+)?compatibilidad/i,
                /comprobar\s+(?:(?:que|si)\s+)?(?:la\s+)?compatibilidad/i,
                /verificar\s+(?:que|si)\s+(?:las?\s+)?matrices?\s+(?:son|sean)\s+compatib/i,
                /verificar\s+(?:(?:que|si)\s+)?(?:las?\s+)?(?:dimensiones|medidas)\s+(?:sean|son|coincid|igual)/i,
                /verificar\s+(?:(?:que|si)\s+)?(?:el\s+)?(?:orden|tama[ñn]o)\s+(?:de\s+)?(?:las?\s+)?matrices?/i,
            ],
            dependent: [
                /sumar\s+(?:las?\s+)?matrices/i,
                /restar\s+(?:las?\s+)?matrices/i,
                /multiplicar\s+(?:las?\s+)?matrices/i,
                /operar\s+(?:las?\s+)?matrices/i,
                /(?:realizar|ejecutar)\s+(?:la\s+)?(?:operaci[oó]n|suma|resta|multiplicaci[oó]n)\s+(?:de\s+)?matrices/i,
                /calcular\s+(?:la\s+)?(?:suma|resta|multiplicaci[oó]n|operaci[oó]n)/i,
                /(?:sumar|restar|multiplicar|operar)\s+(?:los\s+)?(?:elementos|componentes|entradas)/i,
            ],
            contextPatterns: [
                /matrices?/i,
                /dimension/i,
            ],
            reason: 'Verificar dimensiones/compatibilidad ANTES de operar matrices',
        },
        // ── Escribir resultado provisional ANTES de redondear ─────────────
        {
            prerequisite: [
                /(?:escribir|anotar|obtener)\s+(?:el\s+)?resultado\s+provisional/i,
                /(?:escribir|anotar|obtener)\s+(?:el\s+)?resultado\s+(?:con\s+)?(?:todos?\s+(?:los\s+)?)?decimales/i,
                /resultado\s+sin\s+redonde/i,
            ],
            dependent: [
                /identificar\s+(?:el\s+)?(?:\S+\s+)?(?:decimal|d[ií]gito)/i,
                /redonde(?:ar|o)\s+(?:(?:(?:el|al)\s+)?resultado|a\s+\d+\s+decimal)/i,
                /aplicar\s+(?:el\s+)?redondeo/i,
                /(?:aproximar|truncar)\s+(?:el\s+)?resultado/i,
            ],
            contextPatterns: [
                /redonde|redondear|decimal/i,
            ],
            reason: 'Obtener resultado provisional ANTES de redondear (no se puede redondear sin tener el resultado completo)',
        },
        // ── Identificar dígito de redondeo ANTES de aplicar redondeo ──────
        {
            prerequisite: [
                /identificar\s+(?:el\s+)?(?:\S+\s+)?(?:decimal|d[ií]gito)/i,
                /(?:mirar|observar|ver)\s+(?:el\s+)?(?:\S+\s+)?(?:decimal|d[ií]gito)/i,
            ],
            dependent: [
                /aplicar\s+(?:el\s+)?redondeo/i,
                /redonde(?:ar|o)\s+(?:hacia\s+)?(?:arriba|abajo)/i,
                /sumar\s+(?:1|uno)\s+(?:a\s+)?(?:la\s+)?(?:tercera|segunda|primera)\s+decimal/i,
            ],
            contextPatterns: [
                /redonde|redondear/i,
            ],
            reason: 'Identificar el dígito de redondeo ANTES de aplicar el redondeo',
        },
        // ── Calcular/sumar ANTES de escribir resultado provisional ─────────
        {
            prerequisite: [
                /(?:sumar|restar|multiplicar|dividir|operar|calcular)\s+(?:las?\s+)?(?:columnas?|valores?|n[uú]meros?)/i,
                /sumar\s+columna\s+por\s+columna/i,
                /(?:realizar|ejecutar|efectuar)\s+(?:la\s+)?(?:operaci[oó]n|suma|resta)/i,
            ],
            dependent: [
                /(?:escribir|anotar|obtener)\s+(?:el\s+)?resultado\s+provisional/i,
                /resultado\s+provisional\s+con/i,
                /resultado\s+(?:con\s+)?(?:todos?\s+(?:los\s+)?)?decimales/i,
            ],
            contextPatterns: [
                /redonde|decimal|provisional/i,
            ],
            reason: 'Calcular/sumar ANTES de escribir el resultado provisional',
        },
        // ── Leer/analizar problema ANTES de plantear ecuación ──────────────
        {
            prerequisite: [
                /(?:leer|analizar|comprender)\s+(?:el\s+)?(?:problema|enunciado)/i,
            ],
            dependent: [
                /plantear\s+(?:la\s+)?ecuaci[oó]n/i,
                /(?:escribir|formular)\s+(?:la\s+)?ecuaci[oó]n/i,
            ],
            reason: 'Leer/analizar el problema ANTES de plantear la ecuación',
        },
        // ── Factorizar ANTES de encontrar raíces ──────────────────────────
        {
            prerequisite: [
                /factorizar/i,
                /simplificar\s+(?:la\s+)?(?:expresi[oó]n|ecuaci[oó]n)/i,
            ],
            dependent: [
                /(?:encontrar|hallar|obtener)\s+(?:las?\s+)?ra[ií]ces?/i,
                /(?:encontrar|hallar|obtener)\s+(?:los?\s+)?(?:valores?\s+de\s+)?x/i,
            ],
            reason: 'Factorizar/simplificar ANTES de encontrar raíces',
        },
    ];

    applies(question, items) {
        return StepDependencyOrderRule.DEPENDENCY_PAIRS.some(pair => {
            // Check context patterns if defined
            if (pair.contextPatterns) {
                const contextMatch = pair.contextPatterns.some(p =>
                    p.test(question) || items.some(item => p.test(item))
                );
                if (!contextMatch) return false;
            }
            // Check if both prerequisite and dependent patterns exist in items
            const hasPrereq = items.some(item =>
                pair.prerequisite.some(p => p.test(item))
            );
            const hasDep = items.some(item =>
                pair.dependent.some(p => p.test(item))
            );
            return hasPrereq && hasDep;
        });
    }

    apply(question, items) {
        let currentItems = [...items];
        let modified = false;
        const reasons = [];

        for (const pair of StepDependencyOrderRule.DEPENDENCY_PAIRS) {
            // Check context
            if (pair.contextPatterns) {
                const contextMatch = pair.contextPatterns.some(p =>
                    p.test(question) || currentItems.some(item => p.test(item))
                );
                if (!contextMatch) continue;
            }

            // Find prerequisite and dependent indices
            const prereqIdx = currentItems.findIndex(item =>
                pair.prerequisite.some(p => p.test(item))
            );
            const depIdx = currentItems.findIndex(item =>
                pair.dependent.some(p => p.test(item))
            );

            if (prereqIdx === -1 || depIdx === -1) continue;

            // If dependent comes BEFORE prerequisite → wrong order
            if (depIdx < prereqIdx) {
                // Move prerequisite to just before the dependent
                const [prereqStep] = currentItems.splice(prereqIdx, 1);
                currentItems.splice(depIdx, 0, prereqStep);
                modified = true;
                reasons.push(
                    `${pair.reason}: "${prereqStep}" movido antes de "${currentItems[depIdx + 1]}"`
                );
            }
        }

        if (!modified) return { modified: false };

        return {
            modified: true,
            items: currentItems,
            reason: reasons.join('; '),
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Orquestador principal
// ═══════════════════════════════════════════════════════════════════════════

export class OrderingQuestionValidator {
    /**
     * @param {Array} rules - Reglas de validación a aplicar en orden
     */
    constructor(rules = null) {
        this.rules = rules || OrderingQuestionValidator._defaultRules();
    }

    /**
     * Valida y corrige los items de una pregunta de ordenamiento.
     *
     * @param {string} question - Texto de la pregunta
     * @param {string[]} items - Items en su orden "correcto" según el LLM
     * @returns {{ valid: boolean, items?: string[], reason?: string, corrections?: string[] }}
     */
    validate(question, items) {
        if (!items || items.length < 3) {
            return { valid: false, reason: 'Menos de 3 items para ordenar' };
        }

        let currentItems = [...items];
        const corrections = [];

        for (const rule of this.rules) {
            if (!rule.applies(question, currentItems)) continue;

            const result = rule.apply(question, currentItems);

            if (result.reject) {
                return { valid: false, reason: result.reason };
            }

            if (result.modified && result.items) {
                corrections.push(result.reason);
                currentItems = result.items;
            }
        }

        if (currentItems.length < 3) {
            return { valid: false, reason: 'Menos de 3 items después de corregir pasos redundantes' };
        }

        return {
            valid: true,
            items: currentItems,
            corrections: corrections.length > 0 ? corrections : undefined,
        };
    }

    /**
     * Método estático de conveniencia — usa la instancia singleton.
     * @param {string} question
     * @param {string[]} items
     * @returns {{ valid: boolean, items?: string[], reason?: string, corrections?: string[] }}
     */
    static validateQuestion(question, items) {
        return OrderingQuestionValidator.getInstance().validate(question, items);
    }

    /** @returns {OrderingQuestionValidator} Singleton */
    static getInstance() {
        if (!OrderingQuestionValidator._instance) {
            OrderingQuestionValidator._instance = new OrderingQuestionValidator();
        }
        return OrderingQuestionValidator._instance;
    }

    /** @private Reglas por defecto, en orden de prioridad */
    static _defaultRules() {
        return [
            new StepDependencyOrderRule(),      // 1. Dependencias lógicas (convertir → alinear, derivar → igualar a 0, etc.)
            new DecimalCommaRule(),              // 2. Fusionar coma decimal con alineación
            new RedundantStepRule(),             // 3. Eliminar pasos redundantes genéricos
            new ArithmeticProcedureOrderRule(),  // 4. Acarreos ANTES de continuar (bug crítico)
            new AlignmentFirstRule(),            // 5. Alineación siempre primero
            new VerificationLastRule(),          // 6. Verificación siempre al final (debe ir ANTES de WriteResult)
            new WriteResultLastRule(),           // 7. Resultado justo antes de verificación (corre tras VerificationLastRule)
            new OperationBeforeResultRule(),     // 8. Todas las operaciones antes del resultado
            new StepCountConsistencyRule(),      // 9. Consistencia de conteo
        ];
    }
}

// Exportaciones individuales para testing
export {
    DecimalCommaRule,
    AlignmentFirstRule,
    VerificationLastRule,
    RedundantStepRule,
    StepCountConsistencyRule,
    ArithmeticProcedureOrderRule,
    WriteResultLastRule,
    OperationBeforeResultRule,
    StepDependencyOrderRule,
};

export default OrderingQuestionValidator;
