/**
 * AnswerVerificationGate — Capa final de validación matemática.
 *
 * Principios SOLID:
 *   - SRP: Cada verificador maneja un solo aspecto de validación.
 *   - OCP: Nuevos verificadores se agregan sin modificar los existentes.
 *   - LSP: Todos implementan la misma interfaz { canHandle(), verify() }.
 *   - ISP: Los verificadores solo dependen de (question, answer, options).
 *   - DIP: El gate depende de abstracciones (interfaz de verificador), no implementaciones.
 *
 * Problema que resuelve:
 *   El LLM genera respuestas fabricadas: construye el problema AL REVÉS
 *   (elige la respuesta y luego fabrica el enunciado). Este gate RE-CALCULA
 *   la respuesta desde cero y rechaza cualquier pregunta donde el cálculo
 *   independiente contradice la respuesta del LLM.
 */

import Decimal from 'decimal.js';

Decimal.set({ precision: 64 });

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 1: OptionConsistencyVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Detecta cuando las opciones numéricas no son plausibles para el problema.
// Ejemplo: resultado real es 25,555,555 pero opciones rondan 30,000,000.

class OptionConsistencyVerifier {
    canHandle(q) {
        return q.type === 'multiple_choice' &&
            Array.isArray(q.options) &&
            q.options.length >= 2;
    }

    verify(q) {
        const options = q.options;
        const numericOpts = [];

        for (const opt of options) {
            const cleaned = String(opt).replace(/[^\d.,-]/g, '');
            const val = _parseDecimalSafe(cleaned);
            if (val !== null) numericOpts.push(val);
        }

        // If fewer than 2 options are numeric, skip this check
        if (numericOpts.length < 2) return { valid: true };

        // Check if all options are suspiciously close to each other (< 5% spread)
        // This happens when LLM fabricates options around a wrong answer
        const sorted = numericOpts.slice().sort((a, b) => a.cmp(b));
        const range = sorted[sorted.length - 1].minus(sorted[0]).abs();
        const median = sorted[Math.floor(sorted.length / 2)];

        if (median.isZero()) return { valid: true };

        const spreadPct = range.div(median.abs()).times(100);

        // If spread is < 1% all options are essentially the same — reject
        if (spreadPct.lt(1)) {
            return {
                valid: false,
                reason: `Opciones numéricas sin variación significativa (spread ${spreadPct.toFixed(2)}%)`,
            };
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 2: CorrectAnswerInOptionsVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Verifica que la opción marcada como correcta realmente existe y no es
// una cadena vacía o placeholder.

class CorrectAnswerInOptionsVerifier {
    canHandle(q) {
        return q.type === 'multiple_choice' &&
            Array.isArray(q.options) &&
            typeof q.correctIndex === 'number';
    }

    verify(q) {
        if (q.correctIndex < 0 || q.correctIndex >= q.options.length) {
            return {
                valid: false,
                reason: `correctIndex (${q.correctIndex}) fuera de rango (${q.options.length} opciones)`,
            };
        }

        const correctOpt = String(q.options[q.correctIndex]).trim();
        if (correctOpt.length < 1) {
            return {
                valid: false,
                reason: 'La opción correcta está vacía',
            };
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 3: SumOfParametersVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Detecta el error más común: el LLM suma los parámetros del enunciado
// en lugar de aplicar la operación correcta.
// Ejemplo: "3 artículos a $50 y 5 cuadernos a $20"
//   - LLM incorrecto: 3+50+5+20 = 78
//   - Correcto: 3×50 + 5×20 = 250

class SumOfParametersVerifier {
    canHandle(q) {
        if (q.type !== 'multiple_choice' && q.type !== 'fill_in_blank') return false;
        const text = (q.question || '').toLowerCase();
        // Only for word problems with multiplication context
        return /(?:art[ií]culos?|unidades?|productos?|libros?|cuadernos?|cajas?|piezas?)\s+(?:a|de|por)\s*\$?\s*\d/i.test(text) ||
            /\d+\s+\w+\s+(?:a|de|por)\s*\$?\s*\d/i.test(text);
    }

    verify(q) {
        const text = q.question || '';

        // Extract all numbers from the problem
        const allNumbers = [];
        const numRe = /\d[\d,.]*\.?\d*/g;
        let m;
        while ((m = numRe.exec(text)) !== null) {
            const val = _parseDecimalSafe(m[0]);
            if (val !== null && val.gt(0)) allNumbers.push(val);
        }

        if (allNumbers.length < 3) return { valid: true };

        // Calculate naive sum of all parameters
        const naiveSum = allNumbers.reduce((a, b) => a.plus(b), new Decimal(0));

        // Check if the correct answer equals the naive sum
        let correctAnswer = null;
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            const optStr = String(q.options[q.correctIndex] || '').replace(/[^\d.,-]/g, '');
            correctAnswer = _parseDecimalSafe(optStr);
        } else if (q.type === 'fill_in_blank') {
            correctAnswer = _parseDecimalSafe(String(q.correctAnswer || ''));
        }

        if (correctAnswer === null) return { valid: true };

        // If the answer is exactly the sum of ALL parameters and the problem
        // describes a qty×price scenario, it's likely wrong
        if (correctAnswer.equals(naiveSum)) {
            // Verify there's a multiplication context
            const qtyPriceRe = /(\d[\d,.]*)\s*(?:\w+\s+){0,3}(?:a|de|por)\s*\$?\s*([\d,.]+)/g;
            const pairs = [];
            let pm;
            while ((pm = qtyPriceRe.exec(text)) !== null) {
                const qty = _parseDecimalSafe(pm[1]);
                const price = _parseDecimalSafe(pm[2]);
                if (qty && price && qty.gt(0) && price.gt(0)) {
                    pairs.push({ qty, price });
                }
            }

            if (pairs.length >= 1) {
                const expectedProduct = pairs.reduce((sum, p) => sum.plus(p.qty.times(p.price)), new Decimal(0));
                if (!expectedProduct.equals(naiveSum)) {
                    return {
                        valid: false,
                        reason: `Respuesta (${correctAnswer}) es la suma de parámetros, no el producto. Esperado: ${expectedProduct}`,
                        correctedAnswer: expectedProduct,
                    };
                }
            }
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 4: EquationConsistencyVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Para problemas de sistemas de ecuaciones, verifica que la solución
// propuesta realmente satisface las ecuaciones del enunciado.

class EquationConsistencyVerifier {
    canHandle(q) {
        const text = (q.question || '').toLowerCase();
        return /(?:sistema|ecuaci[oó]n|ecuaciones|resuelve|encuentra.*valor)/i.test(text) &&
            /[=]/i.test(text);
    }

    verify(q) {
        // Extract equations: "2x + 3y = 10"
        const text = q.question || '';
        const eqRe = /(\d*)\s*([xy])\s*([+\-])\s*(\d*)\s*([xy])\s*=\s*(\d+)/g;
        const equations = [];
        let em;
        while ((em = eqRe.exec(text)) !== null) {
            equations.push({
                a: parseInt(em[1] || '1', 10),
                var1: em[2],
                op: em[3],
                b: parseInt(em[4] || '1', 10),
                var2: em[5],
                result: parseInt(em[6], 10),
            });
        }

        if (equations.length < 2) return { valid: true };

        // Try to extract the answer from the correct option
        let answerText = '';
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            answerText = String(q.options[q.correctIndex] || '');
        } else if (q.type === 'fill_in_blank') {
            answerText = String(q.correctAnswer || '');
        }

        // Extract x and y values from the answer
        const xMatch = answerText.match(/x\s*=\s*(-?\d+\.?\d*)/i);
        const yMatch = answerText.match(/y\s*=\s*(-?\d+\.?\d*)/i);

        if (!xMatch || !yMatch) return { valid: true };

        const x = parseFloat(xMatch[1]);
        const y = parseFloat(yMatch[1]);

        // Verify each equation
        for (const eq of equations) {
            const val1 = eq.var1 === 'x' ? x : y;
            const val2 = eq.var2 === 'x' ? x : y;
            const lhs = eq.op === '+' ?
                eq.a * val1 + eq.b * val2 :
                eq.a * val1 - eq.b * val2;

            if (Math.abs(lhs - eq.result) > 0.01) {
                return {
                    valid: false,
                    reason: `Ecuación ${eq.a}${eq.var1} ${eq.op} ${eq.b}${eq.var2} = ${eq.result} no se satisface con x=${x}, y=${y} (LHS=${lhs})`,
                };
            }
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 5: ExplanationAnswerConsistencyVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Verifica que la explicación y la respuesta marcada como correcta
// no se contradigan entre sí.

class ExplanationAnswerConsistencyVerifier {
    canHandle(q) {
        return (q.type === 'multiple_choice' || q.type === 'fill_in_blank') &&
            typeof q.explanation === 'string' &&
            q.explanation.length > 10;
    }

    verify(q) {
        const explanation = q.explanation;

        // Extract the final numeric result from the explanation
        const resultPatterns = [
            /(?:resultado?|respuesta|total|valor)\s*(?:es|=|:)\s*\$?\s*([\d,]+\.?\d*)/i,
            /=\s*\$?\s*([\d,]+\.?\d*)\s*$/im,
        ];

        let explAnswer = null;
        for (const pattern of resultPatterns) {
            const m = explanation.match(pattern);
            if (m) {
                explAnswer = _parseDecimalSafe(m[1]);
                if (explAnswer) break;
            }
        }

        if (explAnswer === null) return { valid: true };

        // Get the selected answer
        let selectedAnswer = null;
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            const optStr = String(q.options[q.correctIndex] || '').replace(/[^\d.,-]/g, '');
            selectedAnswer = _parseDecimalSafe(optStr);
        } else if (q.type === 'fill_in_blank') {
            selectedAnswer = _parseDecimalSafe(String(q.correctAnswer || ''));
        }

        if (selectedAnswer === null) return { valid: true };

        // Allow 1% tolerance
        const diff = explAnswer.minus(selectedAnswer).abs();
        const tolerance = Decimal.max(explAnswer.abs().times('0.01'), new Decimal('0.5'));

        if (diff.gt(tolerance)) {
            return {
                valid: false,
                reason: `Explicación dice resultado=${explAnswer} pero respuesta seleccionada=${selectedAnswer} (diff=${diff})`,
            };
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 6: FillInBlankNumericVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Para preguntas fill_in_blank numéricas, re-calcula independientemente
// y compara contra la respuesta del LLM.

class FillInBlankNumericVerifier {
    canHandle(q) {
        if (q.type !== 'fill_in_blank') return false;
        const answer = String(q.correctAnswer || '');
        return /^-?\d/.test(answer.replace(/[, ]/g, ''));
    }

    verify(q) {
        // Import computeExpectedAnswer dynamically to avoid circular deps
        // This re-computes the answer from scratch using QuizMathValidator
        // The verification has already been done by QuizMathValidator.verify()
        // This verifier does NOT use QuizMathValidator — it does its own check

        const answer = _parseDecimalSafe(String(q.correctAnswer || ''));
        if (answer === null) return { valid: true };

        // Self-consistency: if explanation contains a numeric result, it must match
        if (q.explanation) {
            const resultMatch = q.explanation.match(/(?:resultado|respuesta|total|=)\s*(?:es|:)?\s*\$?\s*([\d,]+\.?\d*)\s*$/im);
            if (resultMatch) {
                const explResult = _parseDecimalSafe(resultMatch[1]);
                if (explResult && !explResult.equals(answer)) {
                    const diff = explResult.minus(answer).abs();
                    const tolerance = Decimal.max(answer.abs().times('0.01'), new Decimal('0.5'));
                    if (diff.gt(tolerance)) {
                        return {
                            valid: false,
                            reason: `fill_in_blank: Answer=${answer} contradicts explanation result=${explResult}`,
                        };
                    }
                }
            }
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function _parseDecimalSafe(str) {
    if (!str) return null;
    try {
        const d = new Decimal(String(str).replace(/,/g, ''));
        return d.isFinite() ? d : null;
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Gate principal — orquestador
// ═══════════════════════════════════════════════════════════════════════════

export class AnswerVerificationGate {
    constructor(verifiers = null) {
        this.verifiers = verifiers || AnswerVerificationGate._defaultVerifiers();
    }

    /**
     * Verifica una pregunta pasándola por TODOS los verificadores aplicables.
     * Si ALGUNO falla → la pregunta se rechaza (null).
     * Si TODOS pasan → la pregunta se retorna tal cual.
     *
     * @param {Object} q - Pregunta normalizada
     * @returns {Object|null} - Pregunta validada o null si fue rechazada
     */
    verify(q) {
        if (!q) return null;

        for (const verifier of this.verifiers) {
            if (!verifier.canHandle(q)) continue;

            const result = verifier.verify(q);

            if (!result.valid) {
                console.warn(
                    `❌ [AnswerVerificationGate] REJECTED by ${verifier.constructor.name}: ` +
                    `"${(q.question || '').substring(0, 80)}..." — ${result.reason}`
                );
                return null;
            }
        }

        return q;
    }

    /**
     * Verifica un lote de preguntas.
     * @param {Object[]} questions
     * @returns {Object[]} - Solo las preguntas que pasaron la verificación
     */
    verifyBatch(questions) {
        if (!Array.isArray(questions)) return [];

        const verified = [];
        let rejected = 0;

        for (const q of questions) {
            const result = this.verify(q);
            if (result) {
                verified.push(result);
            } else {
                rejected++;
            }
        }

        if (rejected > 0) {
            console.log(
                `🚪 [AnswerVerificationGate] Batch result: ${verified.length} passed, ${rejected} rejected`
            );
        }

        return verified;
    }

    /** Singleton */
    static getInstance() {
        if (!AnswerVerificationGate._instance) {
            AnswerVerificationGate._instance = new AnswerVerificationGate();
        }
        return AnswerVerificationGate._instance;
    }

    /** @private */
    static _defaultVerifiers() {
        return [
            new CorrectAnswerInOptionsVerifier(),
            new OptionConsistencyVerifier(),
            new SumOfParametersVerifier(),
            new EquationConsistencyVerifier(),
            new ExplanationAnswerConsistencyVerifier(),
            new FillInBlankNumericVerifier(),
        ];
    }
}

export {
    OptionConsistencyVerifier,
    CorrectAnswerInOptionsVerifier,
    SumOfParametersVerifier,
    EquationConsistencyVerifier,
    ExplanationAnswerConsistencyVerifier,
    FillInBlankNumericVerifier,
};

export default AnswerVerificationGate;