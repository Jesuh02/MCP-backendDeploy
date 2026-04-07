/**
 * ValidationPipeline — Orquestador de validación matemática.
 *
 * SOLID:
 *   SRP: Solo orquesta el flujo de validación, no calcula ni normaliza.
 *   OCP: Nuevas etapas se agregan sin modificar las existentes.
 *   DIP: Depende de abstracciones (QuizMathValidator, AnswerVerificationGate, MathEngine).
 *
 * Flujo:
 *   1. COMPUTE  — Re-calcula la respuesta desde el enunciado (QuizMathValidator)
 *   2. VERIFY   — Verifica consistencia estructural (AnswerVerificationGate)
 *   3. CROSS    — Cross-valida: respuesta computada vs marcada como correcta
 *   4. REJECT   — Rechaza preguntas con problemas irrecuperables
 *
 * REGLA CARDINAL: NUNCA confiar en la explicación del LLM como fuente de verdad.
 * Si no se puede calcular independientemente → no corregir, solo pasar.
 */

import Decimal from 'decimal.js';
import { MathEngine } from './MathEngine.js';
import { QuizMathValidator } from './QuizMathValidator.js';
import { AnswerVerificationGate } from './AnswerVerificationGate.js';

Decimal.set({ precision: 64 });

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 1: ComputeStage — Re-calcula la respuesta correcta
// ═══════════════════════════════════════════════════════════════════════════

class ComputeStage {
    process(q) {
        if (!q || !q.question) return { question: q, computed: null };

        const text = q.question;
        const result = QuizMathValidator.computeExpectedAnswer(text);

        return { question: q, computed: result };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 2: CrossValidationStage — Compara computado vs marcado
// ═══════════════════════════════════════════════════════════════════════════

class CrossValidationStage {
    process(q, computed) {
        if (!computed || !computed.value) return { action: 'pass', question: q };

        const finalAnswer = this._applyDecimals(computed.value, q.question);

        // --- fill_in_blank ---
        if (q.type === 'fill_in_blank') {
            return this._crossValidateFillInBlank(q, finalAnswer, computed.steps || []);
        }

        // --- multiple_choice ---
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            return this._crossValidateMultipleChoice(q, finalAnswer, computed.steps || []);
        }

        return { action: 'pass', question: q };
    }
    _crossValidateFillInBlank(q, finalAnswer, steps) {
        const current = MathEngine.parseDecimal(String(q.correctAnswer));
        if (!current) return { action: 'pass', question: q };

        if (!current.equals(finalAnswer)) {
            const tolerance = Decimal.max(finalAnswer.abs().times('0.001'), '0.01');
            if (current.minus(finalAnswer).abs().gt(tolerance)) {
                console.warn(
                    `[ValidationPipeline] CORRECTED fill_in_blank: LLM=${q.correctAnswer} → Computed=${finalAnswer}`
                );
                q.correctAnswer = finalAnswer.toFixed();
                q.explanation = steps.join('. ') + '. Resultado final: ' + finalAnswer + '.';
            }
        }
        return { action: 'pass', question: q };
    }

    _crossValidateMultipleChoice(q, finalAnswer, steps) {
        // Check if computed answer is astronomically different from ALL options
        if (this._isBrokenQuestion(finalAnswer, q.options)) {
            console.warn(
                `[ValidationPipeline] REJECTED: computed=${finalAnswer.toExponential(4)} ` +
                `but options are orders of magnitude different. Question: "${q.question.substring(0, 60)}..."`
            );
            return { action: 'reject', question: null };
        }

        const match = MathEngine.findClosestOption(finalAnswer, q.options);

        // No option could be parsed as number → let it pass (text-based question)
        if (match === null) return { action: 'pass', question: q };

        if (match.within) {
            if (match.index !== q.correctIndex) {
                console.warn(
                    `[ValidationPipeline] CORRECTED MC: index ${q.correctIndex} → ${match.index} ` +
                    `(computed=${finalAnswer}, option[${match.index}]=${q.options[match.index]})`
                );
                q.correctIndex = match.index;
                q.explanation = steps.join('. ') + '. Resultado final: ' + finalAnswer + '.';
            }
            return { action: 'pass', question: q };
        }

        // No option matches → REJECT the question
        console.warn(
            `[ValidationPipeline] REJECTED: No option matches computed=${finalAnswer}. ` +
            `Options: ${JSON.stringify(q.options)}`
        );
        return { action: 'reject', question: null };
    }

    _isBrokenQuestion(computedValue, options) {
        if (!computedValue || !Array.isArray(options) || options.length === 0) return false;
        const absResult = computedValue.abs();
        if (absResult.lt(1)) return false;

        let maxOption = new Decimal(0);
        for (const opt of options) {
            const cleaned = String(opt).replace(/[^\d.,-]/g, '');
            const val = MathEngine.parseDecimal(cleaned);
            if (val && val.abs().gt(maxOption)) maxOption = val.abs();
        }
        if (maxOption.isZero()) return false;

        // If result is >10x larger than largest option, question is broken
        return absResult.div(maxOption).gt(10);
    }

    _applyDecimals(value, text) {
        const match = text.match(/redonde[ao].*?(\d+)\s*decimal/i) ||
            text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i);
        if (match) return value.toDecimalPlaces(parseInt(match[1]));
        if (/redonde[ao]\s+a\s+entero/i.test(text)) {
            return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
        }
        return value;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 3: StructuralVerificationStage — Verificaciones estructurales
// ═══════════════════════════════════════════════════════════════════════════

class StructuralVerificationStage {
    constructor() {
        this.gate = AnswerVerificationGate.getInstance();
    }

    process(q) {
        if (!q) return { action: 'reject', question: null };
        const result = this.gate.verify(q);
        if (!result) {
            return { action: 'reject', question: null };
        }
        return { action: 'pass', question: result };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 4: OrderingDependencyStage — Valida dependencias lógicas en ordering
// ═══════════════════════════════════════════════════════════════════════════

class OrderingDependencyStage {
    process(q) {
        if (!q || q.type !== 'ordering') return { action: 'pass', question: q };

        const items = q.items;
        const correctOrder = q.correctOrder;

        if (!Array.isArray(items) || !Array.isArray(correctOrder)) {
            return { action: 'pass', question: q };
        }

        // Build the ordered sequence
        const orderedItems = correctOrder.map(i => items[i]).filter(Boolean);
        if (orderedItems.length < 2) return { action: 'pass', question: q };

        // Check for logical dependency violations in procedural ordering
        const dependencies = this._detectDependencies(orderedItems);
        if (dependencies.violations.length > 0) {
            console.warn(
                `[ValidationPipeline] ORDERING DEPENDENCY VIOLATION: ` +
                `${dependencies.violations.join('; ')} — Question: "${q.question.substring(0, 60)}..."`
            );
            return { action: 'reject', question: null };
        }

        return { action: 'pass', question: q };
    }

    /**
     * Detecta violaciones de dependencia lógica en secuencias de pasos.
     * Ejemplo: "escribir resultado" no puede ir antes de "calcular operación"
     */
    _detectDependencies(orderedItems) {
        const violations = [];
        const lowerItems = orderedItems.map(s => (s || '').toLowerCase());

        // Dependency rules: [prerequisite pattern, dependent pattern, description]
        // Interpretation: DEPENDENT must come AFTER PREREQUISITE.
        // Violation detected when dependent appears at index i and prerequisite at index j > i.
        const rules = [
            [/(?:sumar|restar|multiplicar|dividir|calcular|operar|resolver)/,
                /(?:escribir|anotar|colocar|poner)\s+(?:(?:el|la|los|las|del|de)\s+)*(?:resultado|respuesta|coma|punto)/,
                'No se puede escribir el resultado antes de calcularlo'
            ],
            // ── REGLA CRÍTICA (BUG REPORTADO) ──────────────────────────────────
            // Los acarreos ocurren al sumar cada columna y DEBEN registrarse
            // ANTES de avanzar a la siguiente columna hacia la izquierda.
            [/(?:llevar|registrar|anotar|escribir)\s+(?:el\s+)?acarreo|acarreos?\s+(?:a\s+la\s+)?(?:siguiente|pr[oó]xima)\s+columna|\bacarreos?\s+pendientes?\b/,
                /(?:continuar|seguir|repetir)\s+sumando|(?:continuar|seguir|repetir)\s+restando|pasar\s+a\s+la\s+(?:siguiente|pr[oó]xima)\s+columna|avanzar\s+a\s+la\s+(?:siguiente|pr[oó]xima)\s+columna/,
                'Los acarreos se deben registrar ANTES de continuar con la siguiente columna'
            ],
            // ── Acarreos son consecuencia de operar (regla original ampliada) ──
            [/(?:sumar|restar|calcular|operar)/,
                /^(?:llevar|registrar)\s+(?:el\s+)?acarreo|^acarreos?\b/,
                'Los acarreos son consecuencia de la operación, no pueden ir antes'
            ],
            [/(?:alinear|ordenar|colocar|escribir)\s+(?:los\s+)?(?:n[uú]meros|cifras|d[ií]gitos)/,
                /(?:sumar|restar|multiplicar|dividir|calcular|operar)/,
                'Debe alinearse antes de operar'
            ],
            [/(?:calcular|obtener|determinar)\s+(?:el\s+)?(?:resultado|total|suma|producto)/,
                /(?:verificar|comprobar|revisar)/,
                'Debe calcularse antes de verificar'
            ],
            [/(?:identificar|leer|reconocer)\s+(?:el\s+)?(?:problema|datos|enunciado|valores)/,
                /(?:calcular|operar|resolver|aplicar\s+f[oó]rmula)/,
                'Debe identificar datos antes de calcular'
            ],
            // ── Escribir resultado es el penúltimo/último paso (antes de verificar) ──
            [/(?:sumar|restar|multiplicar|dividir|calcular|operar|resolver)/,
                /^(?:escribir|anotar|registrar|poner)\s+(?:el\s+)?resultado\s+final/,
                'El resultado final se escribe después de completar la operación'
            ],
            // ── Identificar/plantear el problema antes de ejecutar ─────────────
            [/(?:leer|analizar|identificar|comprender|plantear)\s+(?:el\s+)?(?:problema|enunciado|ejercicio)/,
                /(?:sumar|restar|multiplicar|dividir|aplicar|calcular|resolver)/,
                'Debe analizarse el problema antes de operarlo'
            ],
        ];

        for (let i = 0; i < lowerItems.length; i++) {
            for (let j = i + 1; j < lowerItems.length; j++) {
                for (const [prereq, dependent, desc] of rules) {
                    // If item[j] matches prerequisite AND item[i] matches dependent
                    // → item[i] (dependent) came BEFORE item[j] (prerequisite) → VIOLATION
                    if (dependent.test(lowerItems[i]) && prereq.test(lowerItems[j])) {
                        violations.push(`"${orderedItems[i]}" depende de "${orderedItems[j]}": ${desc}`);
                    }
                }
            }
        }

        return { violations };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 5: ParameterSumDetectionStage — Detecta sumas ingenues de parámetros
// ═══════════════════════════════════════════════════════════════════════════

class ParameterSumDetectionStage {
    process(q) {
        if (!q || q.type !== 'multiple_choice') return { action: 'pass', question: q };

        const text = q.question || '';

        // Extract ALL numbers from the question text
        const allNumbers = [];
        const numRe = /\d[\d,]*\.?\d*/g;
        let m;
        while ((m = numRe.exec(text)) !== null) {
            const val = MathEngine.parseDecimal(m[0]);
            if (val !== null && val.gt(0)) allNumbers.push(val);
        }

        if (allNumbers.length < 3) return { action: 'pass', question: q };

        // Get the "correct" answer
        const correctOpt = String(q.options[q.correctIndex] || '').replace(/[^\d.,-]/g, '');
        const correctAnswer = MathEngine.parseDecimal(correctOpt);
        if (!correctAnswer) return { action: 'pass', question: q };

        // Compute naive sum of ALL numbers in the text
        const naiveSum = allNumbers.reduce((a, b) => a.plus(b), new Decimal(0));

        // If the marked answer equals the naive sum, BUT the question context
        // suggests multiplication/series/formula → REJECT
        const isNaiveSum = correctAnswer.minus(naiveSum).abs().lte(1);

        if (isNaiveSum) {
            // Check if the question actually asks for a sum
            const asksForSum = /(?:suma|sumar|total\s+de|cu[aá]nto\s+suman)/i.test(text) &&
                !/(?:serie|progresi[oó]n|secuencia|t[eé]rminos)/i.test(text);

            if (!asksForSum) {
                console.warn(
                    `[ValidationPipeline] PARAMETER SUM detected: answer=${correctAnswer} ` +
                    `equals naive sum of all numbers. Question: "${text.substring(0, 60)}..."`
                );
                return { action: 'reject', question: null };
            }
        }

        return { action: 'pass', question: q };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 6: FillInBlankSanityStage — Rechaza fill_in_blank con respuestas absurdas
// ═══════════════════════════════════════════════════════════════════════════

class FillInBlankSanityStage {
    process(q) {
        if (!q || q.type !== 'fill_in_blank') return { action: 'pass', question: q };

        const text = q.question || '';
        const answer = MathEngine.parseDecimal(String(q.correctAnswer || ''));
        if (!answer) return { action: 'pass', question: q };

        const isSciNotation = /notaci[oó]n\s+cient[ií]fica/i.test(text);
        const wantsCoefficient = /coeficiente|mantisa/i.test(text);
        const wantsExponent = /exponente/i.test(text);

        // Check 1: Scientific notation coefficient must be in [1, 10)
        if (isSciNotation && wantsCoefficient) {
            const abs = answer.abs();
            if (abs.gte(10) || abs.isZero()) {
                console.warn(
                    `[ValidationPipeline] SANITY REJECT: fill_in_blank coefficient=${answer} ` +
                    `not in [1,10). Question: "${text.substring(0, 80)}..."`
                );
                return { action: 'reject', question: null };
            }
        }

        // Check 2: Scientific notation exponent must be a small integer
        if (isSciNotation && wantsExponent) {
            if (!answer.isInteger() || answer.abs().gt(50)) {
                console.warn(
                    `[ValidationPipeline] SANITY REJECT: fill_in_blank exponent=${answer} ` +
                    `is not a reasonable integer. Question: "${text.substring(0, 80)}..."`
                );
                return { action: 'reject', question: null };
            }
        }

        // Check 3: If answer is a round power of 10 in a sci-notation question
        // that asks for a "resultado" or "suma", it's likely the base not the answer
        if (isSciNotation && !wantsExponent && !wantsCoefficient) {
            const abs = answer.abs();
            if (abs.gte(1000)) {
                try {
                    const log10 = abs.log(10);
                    const rounded = log10.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
                    if (log10.minus(rounded).abs().lt('0.0001') && /resultado|suma|total/i.test(text)) {
                        // Answer is exactly 10^N — very suspicious for a sum question
                        console.warn(
                            `[ValidationPipeline] SANITY WARNING: fill_in_blank answer=${answer} ` +
                            `is exactly 10^${rounded} in scientific notation question. ` +
                            `Checking if it could be a confused exponent response.`
                        );
                        // Only reject if the question explicitly mentions summing sci-notation numbers
                        if (/suma[rn]?\s+.*notaci[oó]n\s+cient[ií]fica|notaci[oó]n\s+cient[ií]fica.*suma/i.test(text)) {
                            return { action: 'reject', question: null };
                        }
                    }
                } catch (_) { /* log might fail for edge cases */ }
            }
        }

        return { action: 'pass', question: q };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 7: ScientificNotationCrossCheckStage
// ═══════════════════════════════════════════════════════════════════════════

class ScientificNotationCrossCheckStage {
    process(q) {
        if (!q || q.type !== 'multiple_choice') return { action: 'pass', question: q };

        const text = q.question || '';
        if (!/notaci[oó]n\s+cient[ií]fica/i.test(text)) return { action: 'pass', question: q };

        // Extract the number to convert from the question
        const numMatch = text.match(
            /(?:expres[ae]r?|convert[ie]r?|escrib[ie]r?|represent[ae]r?)[\s\S]*?(\d[\d,. ]*\d)/i
        );
        if (!numMatch) return { action: 'pass', question: q };

        const originalNum = MathEngine.parseDecimal(numMatch[1].replace(/\s/g, ''));
        if (!originalNum || originalNum.isZero()) return { action: 'pass', question: q };

        // Compute correct scientific notation
        const { mantissa, exponent } = MathEngine.toScientificNotation(originalNum);

        // Find which option best matches the correct notation
        const sciPatterns = [
            /(\d+\.?\d*)\s*[×x]\s*10\s*\^?\s*(\d+)/i,
            /(\d+\.?\d*)\s*[×x]\s*10\s*([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/i,
            /(\d+\.?\d*)e(\d+)/i,
        ];

        let bestIdx = -1;
        let bestDiff = new Decimal(Infinity);

        for (let i = 0; i < q.options.length; i++) {
            const opt = String(q.options[i]);
            for (const pattern of sciPatterns) {
                const m = opt.match(pattern);
                if (!m) continue;

                const optMantissa = MathEngine.parseDecimal(m[1]);
                const expStr = m[2].replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c =>
                    '0123456789' ['⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)] || c
                );
                const optExp = parseInt(expStr, 10);
                if (!optMantissa || isNaN(optExp)) continue;

                const optValue = optMantissa.times(new Decimal(10).pow(optExp));
                const diff = optValue.minus(originalNum).abs();
                if (diff.lt(bestDiff)) {
                    bestDiff = diff;
                    bestIdx = i;
                }
            }
        }

        if (bestIdx !== -1 && bestIdx !== q.correctIndex) {
            const tolerance = originalNum.abs().times('0.001');
            if (bestDiff.lte(tolerance)) {
                console.warn(
                    `[ValidationPipeline] SCI NOTATION CORRECTED: index ${q.correctIndex} → ${bestIdx}. ` +
                    `Original number: ${originalNum}, correct notation mantissa≈${mantissa.toFixed(4)} × 10^${exponent}`
                );
                q.correctIndex = bestIdx;
                return { action: 'pass', question: q };
            }
        }

        return { action: 'pass', question: q };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline principal
// ═══════════════════════════════════════════════════════════════════════════

export class ValidationPipeline {
    constructor() {
        this.computeStage = new ComputeStage();
        this.crossStage = new CrossValidationStage();
        this.structuralStage = new StructuralVerificationStage();
        this.orderingStage = new OrderingDependencyStage();
        this.paramSumStage = new ParameterSumDetectionStage();
        this.fillBlankSanityStage = new FillInBlankSanityStage();
        this.sciNotationStage = new ScientificNotationCrossCheckStage();
    }

    /**
     * Valida una pregunta individual a través del pipeline completo.
     * @param {Object} q - Pregunta normalizada
     * @returns {Object|null} - Pregunta validada o null si fue rechazada
     */
    validate(q) {
        if (!q) return null;

        try {
            // Stage 1: Compute expected answer independently
            const { computed } = this.computeStage.process(q);

            // Stage 2: Cross-validate computed vs marked answer
            if (computed) {
                const crossResult = this.crossStage.process(q, computed);
                if (crossResult.action === 'reject') return null;
                q = crossResult.question;
            }

            // Stage 3: Parameter sum detection (anti-fabrication)
            const paramResult = this.paramSumStage.process(q);
            if (paramResult.action === 'reject') return null;
            q = paramResult.question;

            // Stage 3.5: Fill-in-blank sanity check (coefficient range, round powers of 10)
            const fillSanity = this.fillBlankSanityStage.process(q);
            if (fillSanity.action === 'reject') return null;
            q = fillSanity.question;

            // Stage 4: Scientific notation cross-check
            const sciResult = this.sciNotationStage.process(q);
            if (sciResult.action === 'reject') return null;
            q = sciResult.question;

            // Stage 5: Ordering dependency validation
            const orderResult = this.orderingStage.process(q);
            if (orderResult.action === 'reject') return null;
            q = orderResult.question;

            // Stage 6: Structural verification gate (existing verifiers)
            const structResult = this.structuralStage.process(q);
            if (structResult.action === 'reject') return null;
            q = structResult.question;

            return q;
        } catch (err) {
            console.warn(`[ValidationPipeline] Error (non-blocking): ${err.message}`);
            return q; // Don't reject on internal errors
        }
    }

    /**
     * Valida un lote de preguntas.
     * @param {Object[]} questions
     * @returns {Object[]} - Solo las preguntas que pasaron
     */
    validateBatch(questions) {
        if (!Array.isArray(questions)) return [];

        const validated = [];
        let rejected = 0;

        for (const q of questions) {
            const result = this.validate(q);
            if (result) {
                validated.push(result);
            } else {
                rejected++;
            }
        }

        if (rejected > 0) {
            console.log(
                `🔬 [ValidationPipeline] Batch: ${validated.length} passed, ${rejected} rejected`
            );
        }

        return validated;
    }

    /** Singleton */
    static getInstance() {
        if (!ValidationPipeline._instance) {
            ValidationPipeline._instance = new ValidationPipeline();
        }
        return ValidationPipeline._instance;
    }
}

export default ValidationPipeline;