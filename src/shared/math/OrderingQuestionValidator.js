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

    applies(question, items) {
        return AlignmentFirstRule.ARITHMETIC_QUESTION.test(question) &&
            items.some(item => AlignmentFirstRule.ALIGN_PATTERNS.some(p => p.test(item)));
    }

    apply(question, items) {
        const alignIdx = items.findIndex(item =>
            AlignmentFirstRule.ALIGN_PATTERNS.some(p => p.test(item))
        );

        if (alignIdx <= 0) return { modified: false }; // Already first or not found

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
    ];

    applies(question, items) {
        return items.some(item =>
            VerificationLastRule.VERIFY_PATTERNS.some(p => p.test(item))
        );
    }

    apply(question, items) {
        const verifyIdx = items.findIndex(item =>
            VerificationLastRule.VERIFY_PATTERNS.some(p => p.test(item))
        );

        if (verifyIdx === -1 || verifyIdx === items.length - 1) {
            return { modified: false };
        }

        const fixed = [...items];
        const [step] = fixed.splice(verifyIdx, 1);
        fixed.push(step);

        return {
            modified: true,
            items: fixed,
            reason: `Paso de verificación movido al final (estaba en posición ${verifyIdx + 1})`,
        };
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
            new DecimalCommaRule(),      // 1. Fusionar coma decimal con alineación
            new RedundantStepRule(),      // 2. Eliminar pasos redundantes genéricos
            new AlignmentFirstRule(),     // 3. Alineación siempre primero
            new VerificationLastRule(),   // 4. Verificación siempre al final
            new StepCountConsistencyRule(), // 5. Consistencia de conteo
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
};

export default OrderingQuestionValidator;
