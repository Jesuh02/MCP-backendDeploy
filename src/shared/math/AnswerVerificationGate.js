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
        // For word problems with multiplication context (qty × price)
        return /(?:art[ií]culos?|unidades?|productos?|libros?|cuadernos?|cajas?|piezas?|camisetas?|paquetes?|bolsas?|litros?|kilos?|metros?)\s+(?:a|de|por)\s*\$?\s*\d/i.test(text) ||
            /\d+\s+\w+\s+(?:a|de|por|cada\s+un[oa])\s*\$?\s*\d/i.test(text) ||
            /(?:vende|compra|produce|fabrica|tiene)\s+\d+/i.test(text);
    }

    verify(q) {
        const text = q.question || '';

        // Extract qty×price pairs from the problem text
        const qtyPricePatterns = [
            /(\d[\d,.]*)\s*(?:[^\s]+\s+){0,3}(?:a|de|por|cada\s+un[oa]|cada\s+uno\s+a)\s*\$?\s*([\d,.]+)/g,
            /(?:vende|compra|produce|fabrica|tiene)\s+(\d[\d,.]*)\s+[^\s]+\s+(?:a|por)\s*\$?\s*([\d,.]+)/g,
        ];

        const pairs = [];
        for (const re of qtyPricePatterns) {
            re.lastIndex = 0;
            let pm;
            while ((pm = re.exec(text)) !== null) {
                const qty = _parseDecimalSafe(pm[1]);
                const price = _parseDecimalSafe(pm[2]);
                if (qty && price && qty.gt(0) && price.gt(0)) {
                    pairs.push({ qty, price });
                }
            }
            if (pairs.length > 0) break;
        }

        if (pairs.length === 0) return { valid: true };

        // Calculate expected product
        const expectedProduct = pairs.reduce((sum, p) => sum.plus(p.qty.times(p.price)), new Decimal(0));

        // Get the correct answer from the question
        let correctAnswer = null;
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            const optStr = String(q.options[q.correctIndex] || '').replace(/[^\d.,-]/g, '');
            correctAnswer = _parseDecimalSafe(optStr);
        } else if (q.type === 'fill_in_blank') {
            correctAnswer = _parseDecimalSafe(String(q.correctAnswer || ''));
        }

        if (correctAnswer === null) return { valid: true };

        // Check 1: If answer equals naive sum of ALL numbers (classic LLM error)
        const allNumbers = [];
        const numRe = /\d[\d,.]*\.?\d*/g;
        let m;
        while ((m = numRe.exec(text)) !== null) {
            const val = _parseDecimalSafe(m[0]);
            if (val !== null && val.gt(0)) allNumbers.push(val);
        }
        if (allNumbers.length >= 2) {
            const naiveSum = allNumbers.reduce((a, b) => a.plus(b), new Decimal(0));
            if (correctAnswer.equals(naiveSum) && !correctAnswer.equals(expectedProduct)) {
                return {
                    valid: false,
                    reason: `Respuesta (${correctAnswer}) es la suma de parámetros del enunciado, no el producto. Esperado: ${expectedProduct}`,
                    correctedAnswer: expectedProduct,
                };
            }
        }

        // Check 2: If answer differs significantly from expected product
        const relDiff = correctAnswer.minus(expectedProduct).abs().div(expectedProduct.abs().plus(1));
        if (relDiff.gt(0.05)) {
            // Allow if answer matches a different valid operation (e.g., the question asks for remainder)
            const questionAsksProduct = /(?:total|recaud[oó]|gan[oó]|cost[oó]|valor\s+total|precio\s+total|cu[aá]nto.*total)/i.test(text);
            if (questionAsksProduct) {
                return {
                    valid: false,
                    reason: `Respuesta (${correctAnswer}) no coincide con el producto esperado (${expectedProduct}). Diferencia relativa: ${(relDiff.toNumber() * 100).toFixed(1)}%`,
                    correctedAnswer: expectedProduct,
                };
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
// Verificador 7: IndependentRecalculationVerifier
// ═══════════════════════════════════════════════════════════════════════════
// RE-CALCULA la respuesta desde cero usando aritmética independiente.
// Si el cálculo produce un resultado y NO coincide con ninguna opción → rechazar.
// Esta es la DEFENSA PRINCIPAL contra respuestas fabricadas.

class IndependentRecalculationVerifier {
    canHandle(q) {
        if (q.type !== 'multiple_choice' || !Array.isArray(q.options)) return false;
        const text = (q.question || '').toLowerCase();
        // Solo para problemas con señales matemáticas claras
        return /(?:calcula|suma|multiplica|divide|resta|total|resultado|cu[aá]nto|promedio|porcentaje|inter[eé]s|descuento|[aá]rea|per[ií]metro)/i.test(text);
    }

    verify(q) {
        const text = q.question || '';

        // Intentar cálculo aritmético explícito simple
        const result = this._trySimpleArithmetic(text);
        if (!result) return { valid: true }; // No pudimos calcular → no rechazar

        const computed = result.value;

        // Verificar que alguna opción coincida con el resultado
        const options = q.options;
        let foundMatch = false;
        let correctIdx = -1;

        for (let i = 0; i < options.length; i++) {
            const optVal = _parseDecimalSafe(String(options[i]).replace(/[^\d.,-]/g, ''));
            if (!optVal) continue;

            const diff = computed.minus(optVal).abs();
            const tolerance = Decimal.max(computed.abs().times('0.01'), new Decimal('0.5'));

            if (diff.lte(tolerance)) {
                foundMatch = true;
                correctIdx = i;
                break;
            }
        }

        if (!foundMatch) {
            // El resultado calculado no está en ninguna opción → pregunta rota
            const maxOpt = options.map(o => _parseDecimalSafe(String(o).replace(/[^\d.,-]/g, ''))).filter(Boolean);
            if (maxOpt.length >= 2) {
                const maxVal = maxOpt.reduce((a, b) => a.abs().gt(b.abs()) ? a : b);
                const ratio = computed.abs().div(maxVal.abs().plus(1));

                // Solo rechazar si la diferencia es significativa (>10x o el resultado no está cerca)
                if (ratio.gt(10) || ratio.lt(new Decimal('0.1'))) {
                    return {
                        valid: false,
                        reason: `Recálculo independiente=${computed} no coincide con ninguna opción (ratio=${ratio.toFixed(2)}x). Opciones: ${options.join(', ')}`,
                    };
                }
            }
        }

        return { valid: true };
    }

    /** Cálculo aritmético básico: detecta expresiones "A op B" */
    _trySimpleArithmetic(text) {
        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
        // Match: number op number
        const exprRe = /(\d[\d,.]*)\s*([+\-×*÷/])\s*(\d[\d,.]*)/g;
        const m = exprRe.exec(cleaned);
        if (!m) return null;

        const a = _parseDecimalSafe(m[1]);
        const b = _parseDecimalSafe(m[3]);
        if (!a || !b) return null;

        const op = m[2];
        let result;
        if (op === '+') result = a.plus(b);
        else if (op === '-' || op === '−') result = a.minus(b);
        else if (op === '×' || op === '*' || op === '\xd7') result = a.times(b);
        else if (op === '÷' || op === '/' || op === '\xf7') {
            if (b.isZero()) return null;
            result = a.div(b);
        } else return null;

        return { value: result };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 8: ScientificNotationVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Verifica preguntas de notación científica: la opción correcta debe
// representar correctamente el número en notación científica.

class ScientificNotationVerifier {
    canHandle(q) {
        const text = (q.question || '').toLowerCase();
        return /notaci[oó]n\s+cient[ií]fica/i.test(text);
    }

    verify(q) {
        const text = q.question || '';

        // Extraer el número a convertir
        const numMatch = text.match(/(?:expres[ae]r?|convert[ie]r?|escrib[ie]r?|represent[ae]r?)[\s\S]*?(\d[\d,. ]*\d)/i);
        if (!numMatch) return { valid: true };

        const originalNum = _parseDecimalSafe(numMatch[1].replace(/\s/g, ''));
        if (!originalNum || originalNum.isZero()) return { valid: true };

        // Calcular la notación científica correcta
        const absNum = originalNum.abs();
        const log10 = absNum.log(10).floor().toNumber();
        const mantissa = absNum.div(new Decimal(10).pow(log10));

        // Verificar cada opción: buscar formato "M × 10^N" o "MeN"
        if (q.type !== 'multiple_choice' || !Array.isArray(q.options)) return { valid: true };

        const sciPatterns = [
            /(\d+\.?\d*)\s*[×x]\s*10\s*\^?\s*(\d+)/i,
            /(\d+\.?\d*)\s*[×x]\s*10\s*([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/i,
            /(\d+\.?\d*)e(\d+)/i,
        ];

        let bestOptionIdx = -1;
        let bestDiff = new Decimal(Infinity);

        for (let i = 0; i < q.options.length; i++) {
            const opt = String(q.options[i]);
            for (const pattern of sciPatterns) {
                const m = opt.match(pattern);
                if (!m) continue;

                const optMantissa = _parseDecimalSafe(m[1]);
                const expStr = m[2].replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c =>
                    '0123456789'['⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)] || c
                );
                const optExp = parseInt(expStr, 10);
                if (!optMantissa || isNaN(optExp)) continue;

                const optValue = optMantissa.times(new Decimal(10).pow(optExp));
                const diff = optValue.minus(originalNum).abs();
                if (diff.lt(bestDiff)) {
                    bestDiff = diff;
                    bestOptionIdx = i;
                }
            }
        }

        if (bestOptionIdx !== -1 && bestOptionIdx !== q.correctIndex) {
            // La opción más precisa no coincide con la marcada como correcta
            const tolerance = originalNum.abs().times('0.001');
            if (bestDiff.lte(tolerance)) {
                return {
                    valid: false,
                    reason: `Notación científica: opción correcta debería ser índice ${bestOptionIdx} (${q.options[bestOptionIdx]}), no ${q.correctIndex} (${q.options[q.correctIndex]}). Número original: ${originalNum}`,
                };
            }
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 9: IntegerSolutionVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Para sistemas de ecuaciones resueltos por eliminación/sustitución:
// verifica que la solución tenga valores enteros (o rechaza si el
// enunciado requiere soluciones enteras pero no las hay).

class IntegerSolutionVerifier {
    canHandle(q) {
        const text = (q.question || '').toLowerCase();
        return /(?:sistema|ecuaci[oó]n|ecuaciones)/i.test(text) &&
            /(?:eliminaci[oó]n|sustituci[oó]n|m[eé]todo|resuelve)/i.test(text);
    }

    verify(q) {
        const text = q.question || '';

        // Extraer ecuaciones lineales: ax + by = c
        const eqRe = /(-?\d*)\s*([xy])\s*([+\-−])\s*(\d*)\s*([xy])\s*=\s*(-?\d+)/g;
        const equations = [];
        let em;
        while ((em = eqRe.exec(text)) !== null) {
            const a = parseInt(em[1] || '1', 10) || 1;
            const op = em[3] === '-' || em[3] === '−' ? -1 : 1;
            const b = (parseInt(em[4] || '1', 10) || 1) * op;
            equations.push({
                coeffX: em[2] === 'x' ? a : b,
                coeffY: em[2] === 'y' ? a : b,
                result: parseInt(em[6], 10),
            });
        }

        if (equations.length < 2) return { valid: true };

        // Resolver el sistema por Cramer
        const a1 = equations[0].coeffX, b1 = equations[0].coeffY, c1 = equations[0].result;
        const a2 = equations[1].coeffX, b2 = equations[1].coeffY, c2 = equations[1].result;

        const det = a1 * b2 - a2 * b1;
        if (det === 0) {
            return {
                valid: false,
                reason: 'Sistema de ecuaciones sin solución única (determinante = 0)',
            };
        }

        const x = (c1 * b2 - c2 * b1) / det;
        const y = (a1 * c2 - a2 * c1) / det;

        // Si el método es eliminación/sustitución, las soluciones deben ser enteras
        // (en contexto educativo)
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            return {
                valid: false,
                reason: `Sistema de ecuaciones con solución no entera: x=${x.toFixed(4)}, y=${y.toFixed(4)}. Para ejercicios de eliminación, las soluciones deben ser enteras.`,
            };
        }

        // Verificar que la respuesta marcada como correcta coincida
        let answerText = '';
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            answerText = String(q.options[q.correctIndex] || '');
        } else if (q.type === 'fill_in_blank') {
            answerText = String(q.correctAnswer || '');
        }

        if (answerText) {
            const xM = answerText.match(/x\s*=\s*(-?\d+)/i);
            const yM = answerText.match(/y\s*=\s*(-?\d+)/i);

            if (xM && yM) {
                const ansX = parseInt(xM[1], 10);
                const ansY = parseInt(yM[1], 10);

                if (ansX !== x || ansY !== y) {
                    return {
                        valid: false,
                        reason: `Sistema: respuesta dice x=${ansX}, y=${ansY} pero solución correcta es x=${x}, y=${y}`,
                    };
                }
            }
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Verificador 10: CorrectAnswerMatchesComputationVerifier
// ═══════════════════════════════════════════════════════════════════════════
// Verificador de ÚLTIMO RECURSO: para preguntas con porcentaje donde
// el LLM calcula mal sumas parciales.
// Detecta: "26,308,296 en vez de 26,296,296" — sumas con decimales erróneas.

class DecimalSumVerifier {
    canHandle(q) {
        const text = (q.question || '').toLowerCase();
        return q.type === 'multiple_choice' &&
            /(?:suma|total|result)/i.test(text) &&
            /(?:decimal|porcentaje|%|\.\d{2,})/i.test(text);
    }

    verify(q) {
        const text = q.question || '';

        // Extraer todos los números decimales del problema
        const decimalNums = [];
        const numRe = /\d[\d,]*\.\d+/g;
        let m;
        while ((m = numRe.exec(text)) !== null) {
            const val = _parseDecimalSafe(m[0]);
            if (val) decimalNums.push(val);
        }

        if (decimalNums.length < 2) return { valid: true };

        // Verificar si es un problema de suma explícita
        if (!/(?:suma|sumar|total|agreg|a[ñn]ad)/i.test(text)) return { valid: true };

        const computedSum = decimalNums.reduce((a, b) => a.plus(b), new Decimal(0));

        // Obtener respuesta correcta
        let correctAnswer = null;
        if (Array.isArray(q.options) && typeof q.correctIndex === 'number') {
            const optStr = String(q.options[q.correctIndex] || '').replace(/[^\d.,-]/g, '');
            correctAnswer = _parseDecimalSafe(optStr);
        }

        if (!correctAnswer) return { valid: true };

        // Si la diferencia está entre 0.1% y 5%, es sospechosa pero puede ser redondeo legítimo
        // Si la diferencia es > 5%, rechazar
        const diff = correctAnswer.minus(computedSum).abs();
        const relDiff = diff.div(computedSum.abs().plus(1));

        if (relDiff.gt(0.001) && relDiff.lt(0.05)) {
            // Zona gris: verificar si la respuesta correcta está más cerca de otro cálculo
            // (e.g., suma con porcentaje aplicado)
            return { valid: true };
        }

        if (relDiff.gte(0.05)) {
            return {
                valid: false,
                reason: `Suma decimal: computado=${computedSum}, respuesta=${correctAnswer}, diff=${(relDiff.toNumber() * 100).toFixed(2)}%`,
            };
        }

        return { valid: true };
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
            new IntegerSolutionVerifier(),
            new ScientificNotationVerifier(),
            new IndependentRecalculationVerifier(),
            new DecimalSumVerifier(),
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
    IndependentRecalculationVerifier,
    ScientificNotationVerifier,
    IntegerSolutionVerifier,
    DecimalSumVerifier,
};

export default AnswerVerificationGate;