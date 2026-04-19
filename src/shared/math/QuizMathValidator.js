import Decimal from 'decimal.js';
import { OrderingQuestionValidator } from './OrderingQuestionValidator.js';
import { MathEngine } from './MathEngine.js';

Decimal.set({ precision: 64 });

const MATH_SIGNALS = /calcula|suma|total|multiplica|divide|resta|resultado|costo\s+total|precio\s+total|monto\s+total|redondea|\xbfcu\xe1nto|cu\xe1ntos|cu\xe1ntas|promedio|media|porcentaje|[a\xe1]rea|per[i\xed]metro|volumen|superficie|inter[e\xe9]s\s+(?:simple|compuesto)|descuento|impuesto|IVA|repartir|dividir|ganancia|utilidad|beneficio|derivada|extremo|m[i\xed]nimo\s+local|m[a\xe1]ximo\s+local|notaci[o\xf3]n\s+cient[i\xed]fica|fracci[o\xf3]n|fracciones|elevado|potencia|exponente|\d+\s*\/\s*\d+\s*[+\-×÷*]/i;
const HAS_SIGNIFICANT_NUMBERS = /\d{3,}/;

const ADVANCED_FORMULA_PATTERNS = [
    /[\u03A3\u2211]/,
    /sumatoria/i,
    /serie\s+geom[e\xe9]trica/i,
    /serie\s+aritm[e\xe9]trica/i,
    /progresi[o\xf3]n\s+geom[e\xe9]trica/i,
    /progresi[o\xf3]n\s+aritm[e\xe9]trica/i,
    /notaci[o\xf3]n\s+cient[i\xed]fica/i,
    /i\s*=\s*\d+\s*(?:a|to)\s+\d+/i,
    /[\u222b]|integral/i,
    /factorial/i,
    /l[i\xed]mite|lim\s*[\u2192\u27f6]/i,
    // derivada removed — now handled by _tryDerivativeExtremaProblem
];

// Patterns that _tryDerivativeExtremaProblem can handle (not skipped as "advanced")
const DERIVATIVE_PATTERNS = [
    /derivada/i,
    /d\/dx/i,
    /extremos?\s+locales?/i,
    /m[i\xed]nimo\s+local/i,
    /m[a\xe1]ximo\s+local/i,
    /punto\s+cr[i\xed]tico/i,
];

const META_QUESTION_PATTERNS = [
    /d[i\xed]gito\s+(?:(?:de|en|que\s+ocupa)\s+)?(?:las?\s+)?(?:posici[o\xf3]n\s+(?:de\s+(?:las?\s+)?)?)?(?:centenas?|decenas?|unidades?|miles?|millones?|millares?)/i,
    /posici[o\xf3]n\s+(?:de\s+(?:las?\s+)?)?(?:centenas?|decenas?|unidades?|miles?|millones?|millares?)/i,
    /posici[o\xf3]n\s+10[\u2070\xb9\xb2\xb3\u2074\u2075\u2076\u2077\u2078\u2079]+/i,
    /\xbfcu[a\xe1]l\s+es\s+el\s+d[i\xed]gito/i,
    /cifra\s+(?:de|en)\s+(?:la\s+)?posici[o\xf3]n/i,
    /d[i\xed]gito\s+(?:que\s+)?(?:est[a\xe1]|se\s+encuentra|ocupa)\s+en/i,
    /qu[e\xe9]\s+(?:d[i\xed]gito|n[u\xfa]mero|cifra)\s+(?:hay|est[a\xe1]|se\s+encuentra|ocupa)/i,
    /(?:centenas?|decenas?|unidades?)\s+de\s+(?:mill[o\xf3]n|millar)/i,
];

// Tolerance for option matching: 0.5% relative OR 0.01 absolute for large numbers
// Tighter than before (was 1% / 0.5) to catch more fabricated answers.
const OPTION_REL_TOLERANCE = new Decimal('0.005');
const OPTION_ABS_TOLERANCE = new Decimal('0.01');
// When a rigorous formula answer is > this factor larger than the max option,
// the question is considered mathematically broken (LLM fabricated options).
const BROKEN_QUESTION_FACTOR = new Decimal('10');

// Patterns that indicate the question asks for the sum of digits of a result
const DIGIT_SUM_PATTERNS = [
    /suma\s+(?:de\s+)?(?:los\s+|sus\s+)?d[i\xed]gitos/i,
    /sumar\s+(?:los\s+|sus\s+)?d[i\xed]gitos/i,
    /total\s+de\s+(?:los\s+|sus\s+)?d[i\xed]gitos/i,
    /d[i\xed]gitos?\s+individuales/i,
];

export class QuizMathValidator {

    static verify(q) {
        if (!q) return q;
        var text = q.question;
        if (!text || typeof text !== 'string') return q;
        var lower = text.toLowerCase();

        var isAdvanced = QuizMathValidator._isAdvancedMathProblem(text);
        var hasMathSignals = MATH_SIGNALS.test(lower) ||
            HAS_SIGNIFICANT_NUMBERS.test(text.replace(/,/g, '')) ||
            isAdvanced;

        if (!hasMathSignals) return q;

        // Meta-questions about digit positions: handle with dedicated strategy
        // instead of skipping (which left bad LLM explanations uncorrected).
        if (META_QUESTION_PATTERNS.some(function(re) { return re.test(text); })) {
            try {
                var digitResult = QuizMathValidator._tryDigitPositionProblem(text);
                if (digitResult) {
                    var digitAnswer = digitResult.value;
                    if (q.type === 'fill_in_blank') {
                        return QuizMathValidator._verifyFillInBlank(q, digitAnswer, digitResult.steps);
                    }
                    if (q.type === 'multiple_choice') {
                        return QuizMathValidator._verifyMultipleChoice(q, digitAnswer, digitResult.steps);
                    }
                }
            } catch (err) {
                console.warn('[MathVerify] Digit-position error: ' + err.message);
            }
            return q;
        }

        try {
            var result = QuizMathValidator.computeExpectedAnswer(text);

            // REGLA CARDINAL: NUNCA usar la explicación del LLM como fuente de verdad.
            // La explicación del LLM puede contener respuestas FABRICADAS.
            // Si no podemos calcular independientemente, NO intentamos corregir.
            // Esto elimina el error raíz: respuestas inventadas hacia atrás.

            if (!result) return q;

            // Sanity check: if the computed answer is orders of magnitude different from ALL
            // options, the question itself is mathematically broken. Reject it.
            if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
                if (QuizMathValidator._isBrokenQuestion(result.value, q.options)) {
                    console.warn('[MathVerify] BROKEN QUESTION: computed gives ' + result.value.toExponential(4) +
                        ' but all options are orders of magnitude different. Rejecting.');
                    return null;
                }
            }

            var finalAnswer = QuizMathValidator._applyDecimals(result.value, text);

            if (q.type === 'fill_in_blank') {
                return QuizMathValidator._verifyFillInBlank(q, finalAnswer, result.steps);
            }
            if (q.type === 'multiple_choice') {
                // Propagate fraction result for exact fraction matching in options
                if (result.fractionResult) {
                    result.steps._fractionResult = result.fractionResult;
                }
                return QuizMathValidator._verifyMultipleChoice(q, finalAnswer, result.steps);
            }
        } catch (err) {
            console.warn('[MathVerify] Error (non-blocking): ' + err.message);
        }
        return q;
    }

    /**
     * Returns true when the rigorous formula answer is so much larger than all options
     * that the question is definitively broken (e.g. geometric series with 25 terms r=3
     * gives ~1.6 billion but all options are < 1000).
     */
    static _isBrokenQuestion(formulaResult, options) {
        if (!formulaResult || !Array.isArray(options) || options.length === 0) return false;
        var absResult = formulaResult.abs();
        if (absResult.lt(1)) return false; // very small results are not "astronomical"
        var maxOption = new Decimal(0);
        for (var i = 0; i < options.length; i++) {
            var optStr = String(options[i]).replace(/[^\d.,-]/g, '');
            var opt = QuizMathValidator._parseDecimal(optStr);
            if (opt && opt.abs().gt(maxOption)) maxOption = opt.abs();
        }
        if (maxOption.isZero()) return false;
        return absResult.div(maxOption).gt(BROKEN_QUESTION_FACTOR);
    }

    static computeExpectedAnswer(text) {
        var result = QuizMathValidator._computeRawAnswer(text);

        // Post-processing: if the question asks for the sum of digits of the result
        var wantsDigitSum = DIGIT_SUM_PATTERNS.some(function(re) { return re.test(text); });
        if (wantsDigitSum) {
            var baseValue = result ? result.value : null;
            var baseSteps = result ? result.steps.slice() : [];

            // If no computed result, try to extract a single target number
            if (!baseValue) {
                var cleaned = text.replace(/[$\u20ac\xa5\xa3\u20a1\u20bf]\s*/g, '');
                var numRe = /\d[\d,]*\.?\d*/g;
                var nm;
                var nums = [];
                while ((nm = numRe.exec(cleaned)) !== null) {
                    var parsed = QuizMathValidator._parseDecimal(nm[0]);
                    if (parsed !== null && parsed.gte(10)) nums.push(parsed);
                }
                if (nums.length === 1) {
                    baseValue = nums[0];
                    baseSteps = ['N\xfamero: ' + baseValue];
                }
            }

            if (baseValue) {
                var intPart = baseValue.abs().floor().toFixed(0);
                var dSum = 0;
                for (var di = 0; di < intPart.length; di++) {
                    if (intPart[di] >= '0' && intPart[di] <= '9') dSum += parseInt(intPart[di], 10);
                }
                var digitStr = intPart.split('').filter(function(c) { return c >= '0' && c <= '9'; }).join(' + ');
                baseSteps.push('Suma de d\xedgitos de ' + intPart + ': ' + digitStr + ' = ' + dSum);
                return { value: new Decimal(dSum), steps: baseSteps };
            }
        }

        return result;
    }

    static _computeRawAnswer(text) {
        // Strategy 0: Digit-position meta-questions (highest priority — prevents
        // downstream strategies from misinterpreting digit position text as arithmetic)
        var digit = QuizMathValidator._tryDigitPositionProblem(text);
        if (digit) return digit;

        // Strategy 1.5 (elevated): Fraction arithmetic BEFORE explicit arithmetic
        // when the text contains fraction patterns (a/b + c/d).
        // This prevents _tryExplicitArithmetic from treating "/" as division
        // and losing fraction precision.
        var hasFractions = /\d+\s*\/\s*\d+/.test(text) && !/\bfecha\b|\bmes\b|\baño\b|\bd[ií]a\b/i.test(text);
        if (hasFractions) {
            var fraction = QuizMathValidator._tryFractionArithmetic(text);
            if (fraction) return fraction;
        }

        // Strategy 1: Explicit arithmetic expressions (highest confidence)
        var arithmetic = QuizMathValidator._tryExplicitArithmetic(text);
        if (arithmetic) return arithmetic;

        // Strategy 1.5: Fraction arithmetic (fallback for cases not caught above)
        if (!hasFractions) {
            var fraction2 = QuizMathValidator._tryFractionArithmetic(text);
            if (fraction2) return fraction2;
        }

        // Strategy 1.8: Exponentiation problems (2.8^40, a elevado a la b)
        var exponent = QuizMathValidator._tryExponentiationProblem(text);
        if (exponent) return exponent;

        // Strategy 2: Formula evaluation (series, summations, combined series)
        var formula = QuizMathValidator._tryFormulaEvaluation(text);
        if (formula) return formula;

        // Strategy 2.5: Derivative / extrema problems (f'(x) = 0)
        var deriv = QuizMathValidator._tryDerivativeExtremaProblem(text);
        if (deriv) return deriv;

        // Strategy 2.6: Scientific notation sum/conversion
        var sciNot = QuizMathValidator._tryScientificNotationSum(text);
        if (sciNot) return sciNot;

        // Skip for advanced math that needs symbolic computation
        // BUT NOT for derivatives (handled above) or sci notation (handled above)
        if (QuizMathValidator._isAdvancedMathProblem(text)) return null;

        // Strategy 3: Compound multi-step problems (multiple qty×price pairs)
        var compound = QuizMathValidator._tryCompoundProblem(text);
        if (compound) return compound;

        // Strategy 4: Multiplication / rate problems (area, qty × price, etc.)
        var mult = QuizMathValidator._tryMultiplicationProblem(text);
        if (mult) return mult;

        // Strategy 5: Percentage-of-base problems ("15% de 200", discounts, taxes)
        var pct = QuizMathValidator._tryPercentageProblem(text);
        if (pct) return pct;

        // Strategy 6: Division problems ("repartir X entre Y")
        var div = QuizMathValidator._tryDivisionProblem(text);
        if (div) return div;

        // Strategy 7: Average / mean problems
        var avg = QuizMathValidator._tryAverageProblem(text);
        if (avg) return avg;

        // Strategy 8: Simple interest / compound interest
        var interest = QuizMathValidator._tryInterestProblem(text);
        if (interest) return interest;

        // Strategy 9: Conservative explicit sum (ONLY for clearly stated sums)
        var sum = QuizMathValidator._tryExplicitSumProblem(text);
        if (sum) return sum;

        // NO blind fallback — if we can't identify the operation, we don't guess
        return null;
    }

    static _isAdvancedMathProblem(text) {
        // Derivative problems are handled by _tryDerivativeExtremaProblem — not skipped
        if (DERIVATIVE_PATTERNS.some(function(re) { return re.test(text); })) return false;
        return ADVANCED_FORMULA_PATTERNS.some(function(re) { return re.test(text); });
    }

    static _reconcileResults(computed, explanation, q) {
        // REGLA CARDINAL: El cálculo independiente SIEMPRE gana.
        // NUNCA usamos la explicación del LLM como fuente de verdad.
        // Si no hay cálculo computado, retornamos null (no intentamos corregir).
        if (!computed) return null;
        return computed;
    }

    static _verifyFillInBlank(q, finalAnswer, steps) {
        var current = QuizMathValidator._parseDecimal(String(q.correctAnswer));
        if (!current) return q;
        if (!current.equals(finalAnswer)) {
            var tolerance = Decimal.max(finalAnswer.abs().times('0.001'), '0.01');
            if (current.minus(finalAnswer).abs().gt(tolerance)) {
                console.warn('[MathVerify] CORRECTED fill_in_blank: LLM=' + q.correctAnswer + ' -> Computed=' + finalAnswer);
            }
            q.correctAnswer = finalAnswer.toFixed();
            q.explanation = steps.join('. ') + '. Resultado final: ' + finalAnswer + '.';
        }
        return q;
    }

    static _verifyMultipleChoice(q, finalAnswer, steps) {
        if (!Array.isArray(q.options) || q.options.length === 0) return q;

        // If we have a fraction result, also try to match fraction strings in options
        var fractionResult = steps && steps._fractionResult;
        if (fractionResult) {
            var fracStr = MathEngine.fractionToString(fractionResult);
            for (var fi = 0; fi < q.options.length; fi++) {
                // Strip letter prefix (e.g., "A) ", "B. ") before parsing fraction
                var optClean = String(q.options[fi]).trim().replace(/^[A-Za-z]\)\s*/, '').replace(/^[A-Za-z]\.\s*/, '').trim();
                // Match exact fraction string (e.g., "89/72")
                var optFrac = MathEngine.parseFraction(optClean);
                if (optFrac && optFrac.num.eq(fractionResult.num) && optFrac.den.eq(fractionResult.den)) {
                    if (fi !== q.correctIndex) {
                        console.warn('[MathVerify] CORRECTED MC (fraction match): index ' + q.correctIndex + ' -> ' + fi +
                            ' (fraction=' + fracStr + ', option[' + fi + ']=' + q.options[fi] + ')');
                        q.correctIndex = fi;
                        q.explanation = steps.join('. ') + '. Resultado final: ' + fracStr + '.';
                    }
                    return q;
                }
            }
        }

        var match = QuizMathValidator._findClosestOption(q.options, finalAnswer);
        // match is null when no option could be parsed as a number — skip validation
        if (match === null) return q;
        if (match.within) {
            if (match.index !== q.correctIndex) {
                console.warn('[MathVerify] CORRECTED MC: index ' + q.correctIndex + ' -> ' + match.index +
                    ' (computed=' + finalAnswer + ', option[' + match.index + ']=' + q.options[match.index] + ')');
                q.correctIndex = match.index;
                q.explanation = steps.join('. ') + '. Resultado final: ' + finalAnswer + '.';
            }
            return q;
        }
        // DOBLE CHECK: Si la respuesta viene de una fuente no verificada (explicación LLM),
        // rechazar absolutamente. Si viene de cálculo propio y no matchea, también rechazar.
        console.warn('[MathVerify] REJECTED MC: No option matches computed=' + finalAnswer +
            '. Options: ' + JSON.stringify(q.options));
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 0: Digit-Position Problems
    // Detects meta-questions asking about specific digits in a number or result:
    // "¿Cuál es el dígito en la posición de las decenas de millón de la suma
    //  12,345,678.9123 + 9,876,543.2187 + ...?"
    // Computes the sum/result, then extracts the digit at the requested position.
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryDigitPositionProblem(text) {
        if (!META_QUESTION_PATTERNS.some(function(re) { return re.test(text); })) return null;

        // Map Spanish position names to powers of 10
        var positionMap = {
            'unidades': 0,
            'unidad': 0,
            'decenas': 1,
            'decena': 1,
            'centenas': 2,
            'centena': 2,
            'miles': 3,
            'mil': 3,
            'millares': 3,
            'millar': 3,
            'decenas de mil': 4,
            'decenas de millar': 4,
            'centenas de mil': 5,
            'centenas de millar': 5,
            'millones': 6,
            'millon': 6,
            'millón': 6,
            'unidades de millón': 6,
            'unidades de millon': 6,
            'decenas de millón': 7,
            'decenas de millon': 7,
            'centenas de millón': 8,
            'centenas de millon': 8,
            'miles de millón': 9,
            'miles de millon': 9,
            'millones de millón': 12,
        };

        // Also handle "posición 10^N" notation with Unicode superscripts
        var superscriptMap = {
            '\u2070': 0,
            '\xb9': 1,
            '\xb2': 2,
            '\xb3': 3,
            '\u2074': 4,
            '\u2075': 5,
            '\u2076': 6,
            '\u2077': 7,
            '\u2078': 8,
            '\u2079': 9
        };

        var lower = text.toLowerCase()
            .replace(/í/g, 'i').replace(/ó/g, 'o').replace(/á/g, 'a')
            .replace(/é/g, 'e').replace(/ú/g, 'u');
        var position = -1;
        var posName = '';

        // Try matching position names from longest to shortest
        var sortedKeys = Object.keys(positionMap).sort(function(a, b) { return b.length - a.length; });
        for (var ki = 0; ki < sortedKeys.length; ki++) {
            var key = sortedKeys[ki];
            var normalizedKey = key.replace(/í/g, 'i').replace(/ó/g, 'o').replace(/á/g, 'a')
                .replace(/é/g, 'e').replace(/ú/g, 'u');
            if (lower.indexOf(normalizedKey) !== -1) {
                position = positionMap[key];
                posName = key;
                break;
            }
        }

        // Try 10^N notation
        if (position < 0) {
            var powMatch = text.match(/10[\u2070\xb9\xb2\xb3\u2074\u2075\u2076\u2077\u2078\u2079]+/);
            if (powMatch) {
                var exp = 0;
                for (var ci = 2; ci < powMatch[0].length; ci++) {
                    var digitChar = powMatch[0][ci];
                    if (superscriptMap[digitChar] !== undefined) {
                        exp = exp * 10 + superscriptMap[digitChar];
                    }
                }
                position = exp;
                posName = 'posición 10^' + exp;
            }
        }

        if (position < 0) return null;

        // Now compute the base number (sum, product, etc.)
        // Extract all substantial numbers from the text
        var cleaned = text.replace(/[$\u20ac\xa5\xa3\u20a1\u20bf]\s*/g, '');
        var allNums = [];
        var numRe = /\d[\d,]*\.?\d*/g;
        var nm;
        while ((nm = numRe.exec(cleaned)) !== null) {
            var parsed = QuizMathValidator._parseDecimal(nm[0]);
            if (parsed !== null) allNums.push(parsed);
        }

        // Determine what operation to perform on the numbers
        var steps = [];
        var baseNumber = null;

        // Check if there's an explicit arithmetic expression
        var exprResult = QuizMathValidator._tryExplicitArithmetic(text);
        if (exprResult) {
            baseNumber = exprResult.value;
            steps = exprResult.steps.slice();
        }

        // If no explicit arithmetic, try sum of significant numbers
        if (!baseNumber && allNums.length >= 2) {
            // Filter out small numbers that are likely not data (e.g., position references, years)
            var dataNums = allNums.filter(function(n) { return n.abs().gte(10); });
            if (dataNums.length >= 2) {
                baseNumber = dataNums.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
                steps.push('Suma: ' + dataNums.join(' + ') + ' = ' + baseNumber);
            }
        }

        // If still no result, check if there's a single large number
        if (!baseNumber && allNums.length === 1 && allNums[0].abs().gte(10)) {
            baseNumber = allNums[0];
            steps.push('Número base: ' + baseNumber);
        }

        if (!baseNumber) return null;

        // Round to integer part for digit extraction
        var integerPart = baseNumber.abs().floor();
        var intStr = integerPart.toFixed(0);

        // Extract the digit at the requested position (0 = ones, 1 = tens, etc.)
        var digitIndex = intStr.length - 1 - position;
        var digit;
        if (digitIndex < 0) {
            digit = 0; // position exceeds the number's length
        } else {
            digit = parseInt(intStr[digitIndex], 10);
        }

        steps.push('Número resultado: ' + baseNumber.toFixed(baseNumber.dp() || 0));
        steps.push('Parte entera: ' + intStr);
        steps.push('Posición ' + posName + ' (10^' + position + '): dígito = ' + digit);

        return { value: new Decimal(digit), steps: steps };
    }

    // Strategy 1: Explicit Arithmetic (uses MathEngine for proper precedence)

    static _tryExplicitArithmetic(text) {
        var cleaned = text.replace(/[$\u20ac\xa5\xa3\u20a1\u20bf]\s*/g, '');
        cleaned = cleaned.replace(/(\d[\d,]*\.?\d*)\s*\(\s*(\d[\d,]*\.?\d*)\s*\)/g, '$1 \xd7 $2');
        var numberPat = '\\d[\\d,]*\\.?\\d*';
        var opPat = '[+\\-\\xd7*\\xf7/\\^]';
        var exprRegex = new RegExp(
            '(' + numberPat + ')\\s*(' + opPat + ')\\s*(' + numberPat + '(?:\\s*' + opPat + '\\s*' + numberPat + ')*)', 'g'
        );
        var match = exprRegex.exec(cleaned);
        if (!match) return null;

        // Use MathEngine for proper operator precedence evaluation
        var exprStr = match[0]
            .replace(/\xd7/g, '*')
            .replace(/\xf7/g, '/')
            .replace(/\u2212/g, '-');

        var result = MathEngine.tryEvaluate(exprStr);
        if (!result) {
            // Fallback to left-to-right evaluation for simple cases
            var tokens = match[0].split(/\s*([+\-\xd7*\xf7/])\s*/).filter(function(t) { return t.trim(); });
            result = QuizMathValidator._parseDecimal(tokens[0]);
            if (!result) return null;
            for (var i = 1; i < tokens.length; i += 2) {
                var op = tokens[i];
                var num = QuizMathValidator._parseDecimal(tokens[i + 1]);
                if (!num) return null;
                if (op === '+') result = result.plus(num);
                else if (op === '-') result = result.minus(num);
                else if (op === '\xd7' || op === '*') result = result.times(num);
                else if (op === '\xf7' || op === '/') {
                    if (num.isZero()) return null;
                    result = result.div(num);
                } else return null;
            }
        }

        var steps = ['Expresión: ' + match[0] + ' = ' + result];

        // Extract individual numbers from the expression for follow-up operations
        var exprNumbers = [];
        var numExtractRe = /\d[\d,]*\.?\d*/g;
        var numM;
        while ((numM = numExtractRe.exec(match[0])) !== null) {
            var nd = QuizMathValidator._parseDecimal(numM[0]);
            if (nd) exprNumbers.push(nd);
        }

        var afterExpr = cleaned.substring(cleaned.indexOf(match[0]) + match[0].length);
        var followUps = QuizMathValidator._detectFollowUpOperations(afterExpr);
        for (var fi = 0; fi < followUps.length; fi++) {
            var prevF = result;
            if (followUps[fi].needsAllNumbers) {
                result = followUps[fi].apply(result, exprNumbers);
            } else {
                result = followUps[fi].apply(result);
            }
            steps.push(followUps[fi].describe(prevF, result));
        }
        return { value: result, steps: steps };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 1.5: Fraction Arithmetic
    // Detects fraction operations: "3/8 + 1/9", "suma de 3/8 y 1/9",
    // "¿cuánto es 2/3 × 5/7?", "resta 1/4 de 3/5"
    // Uses exact fraction arithmetic (GCD-based) for maximum precision.
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryFractionArithmetic(text) {
        // Detect fraction patterns in text
        var fracPat = /(\d+)\s*\/\s*(\d+)/g;
        var fractions = [];
        var fm;
        while ((fm = fracPat.exec(text)) !== null) {
            var num = parseInt(fm[1], 10);
            var den = parseInt(fm[2], 10);
            // Filter out dates (dd/mm, mm/yy), percentages, and very large denominators
            if (den === 0 || den > 10000 || num > 100000) continue;
            // Skip if it looks like a date (1/12, 12/2024, etc.)
            if ((num >= 1 && num <= 31) && (den >= 1 && den <= 12) && /\d{4}|\bfecha\b|\bmes\b|\baño\b|\bd[ií]a\b/i.test(text)) continue;
            fractions.push({ num: num, den: den, pos: fm.index, raw: fm[0] });
        }
        if (fractions.length < 2) return null;

        // Detect operation keywords
        var lower = text.toLowerCase();
        var isSuma = /suma|sumar|agregar|a[ñn]adir|\+/i.test(lower);
        var isResta = /resta|restar|diferencia|sustrae|\-/i.test(lower) && !/resta\s+\d+\s*$/i.test(lower);
        var isMulti = /multiplic|producto|×|\*/i.test(lower);
        var isDiv = /divid|cociente|÷/i.test(lower);

        // Also detect operators between fractions in the text
        var ops = [];
        for (var fi = 0; fi < fractions.length - 1; fi++) {
            var between = text.substring(fractions[fi].pos + fractions[fi].raw.length, fractions[fi + 1].pos);
            if (/\+|más|mas\b|sumad|agreg/i.test(between)) ops.push('+');
            else if (/\-|−|menos|restando|sustrae/i.test(between)) ops.push('-');
            else if (/×|\*|multiplic|por\b/i.test(between)) ops.push('*');
            else if (/÷|÷|entre|dividid/i.test(between)) ops.push('÷');
            else if (isSuma) ops.push('+');
            else if (isResta) ops.push('-');
            else if (isMulti) ops.push('*');
            else if (isDiv) ops.push('÷');
            else ops.push('+'); // Default to sum
        }

        if (ops.length !== fractions.length - 1) return null;

        var steps = [];
        var result = MathEngine.fraction(fractions[0].num, fractions[0].den);
        steps.push('Inicio: ' + MathEngine.fractionToString(result));

        for (var oi = 0; oi < ops.length; oi++) {
            var operand = MathEngine.fraction(fractions[oi + 1].num, fractions[oi + 1].den);
            var prev = MathEngine.fractionToString(result);

            if (ops[oi] === '+') {
                result = MathEngine.fractionAdd(result, operand);
                steps.push(prev + ' + ' + MathEngine.fractionToString(operand) + ' = ' + MathEngine.fractionToString(result));
            } else if (ops[oi] === '-') {
                result = MathEngine.fractionSub(result, operand);
                steps.push(prev + ' - ' + MathEngine.fractionToString(operand) + ' = ' + MathEngine.fractionToString(result));
            } else if (ops[oi] === '*') {
                result = MathEngine.fractionMul(result, operand);
                steps.push(prev + ' × ' + MathEngine.fractionToString(operand) + ' = ' + MathEngine.fractionToString(result));
            } else if (ops[oi] === '÷') {
                result = MathEngine.fractionDiv(result, operand);
                steps.push(prev + ' ÷ ' + MathEngine.fractionToString(operand) + ' = ' + MathEngine.fractionToString(result));
            }
        }

        var decimalValue = MathEngine.fractionToDecimal(result);
        steps.push('Resultado: ' + MathEngine.fractionToString(result) + ' = ' + decimalValue);

        console.log('[MathVerify] Fraction arithmetic: ' + MathEngine.fractionToString(result) + ' = ' + decimalValue);

        return { value: decimalValue, steps: steps, fractionResult: result };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 1.8: Exponentiation Problems
    // Detects and independently computes a^b problems:
    // "2.8^40", "calcula 2.8 elevado a la potencia 40",
    // "¿cuánto es 3.5 elevado a 20?"
    // Uses Decimal.js arbitrary precision to get exact results.
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryExponentiationProblem(text) {
        var lower = text.toLowerCase();

        // Pattern A: Explicit "a^b" or "a ** b" notation
        var patterns = [
            // "2.8^40" or "2.8 ^ 40"
            /(\d+\.?\d*)\s*\^\s*(\d+\.?\d*)/,
            // "2.8 elevado a 40" or "2.8 elevado a la 40"
            /(\d+\.?\d*)\s+elevad[oa]\s+(?:a\s+)?(?:la\s+)?(?:potencia\s+)?(\d+\.?\d*)/i,
            // "potencia de 2.8 a 40" or "potencia 2.8, 40"
            /potencia\s*(?:de\s+)?(\d+\.?\d*)\s*(?:,|a)\s*(\d+\.?\d*)/i,
            // "calcula 2.8 a la 40" or "2.8 a la potencia 40"
            /(\d+\.?\d*)\s+a\s+la\s+(?:potencia\s+)?(\d+\.?\d*)/i,
        ];

        for (var pi = 0; pi < patterns.length; pi++) {
            var m = patterns[pi].exec(text);
            if (!m) continue;

            var base = QuizMathValidator._parseDecimal(m[1]);
            var exponent = QuizMathValidator._parseDecimal(m[2]);

            if (!base || !exponent) continue;
            // Skip trivial cases (x^0, x^1, 0^x, 1^x)
            if (exponent.eq(0) || exponent.eq(1) || base.eq(0) || base.eq(1)) continue;
            // Skip if exponent is very large (> 1000) to avoid performance issues
            if (exponent.gt(1000)) continue;

            var result = MathEngine.verifyExponentiation(base, exponent);
            var steps = result.steps.slice();

            // Cross-verify: compute through ln/exp path for additional confidence
            try {
                var lnBase = base.ln();
                var crossResult = lnBase.times(exponent).exp();
                var crossDiff = result.value.minus(crossResult).abs();
                var crossRelErr = result.value.isZero() ? crossDiff : crossDiff.div(result.value.abs());
                if (crossRelErr.lt('0.0001')) {
                    steps.push('Verificación cruzada (ln/exp): ✓ coinciden');
                } else {
                    steps.push('⚠ Verificación cruzada muestra discrepancia: ' + crossRelErr.toExponential(2));
                }
            } catch (e) {
                // Cross-verify failed, just log
                steps.push('Verificación cruzada no disponible');
            }

            console.log('[MathVerify] Exponentiation: ' + base + '^' + exponent + ' = ' + result.value.toExponential(6) + ' (magnitude: 10^' + result.magnitude + ')');

            return { value: result.value, steps: steps };
        }

        return null;
    }

    // Strategy 2: Formula Evaluation

    static _tryFormulaEvaluation(text) {
        var combined = QuizMathValidator._tryCombinedFormula(text);
        if (combined) return combined;
        var summation = QuizMathValidator._tryPolynomialSummation(text);
        if (summation) return summation;
        var geo = QuizMathValidator._tryGeometricSeriesFormula(text);
        if (geo) return geo;
        // Implicit geometric series: no keyword required, just detectable sequence + term count
        var implicitGeo = QuizMathValidator._tryImplicitGeometricSeries(text);
        if (implicitGeo) return implicitGeo;
        var arith = QuizMathValidator._tryArithmeticSeriesFormula(text);
        if (arith) return arith;
        return null;
    }

    /**
     * Detects a geometric series from the numbers in the text alone, WITHOUT requiring
     * the keyword "serie geométrica". Requires ALL of:
     *   1. At least 3 consecutive values with a consistent ratio (r ≠ 1)
     *   2. An explicit term count ("primeros N términos" / "N terms" / similar)
     *   3. The ratio to be an integer or simple fraction (avoids false positives)
     * This catches questions like: "suma de los primeros 25 términos de la secuencia 4, 12, 36, 108"
     */
    static _tryImplicitGeometricSeries(text) {
        // Must ask for a sum / total of terms
        if (!/(?:suma|total|sumatoria|calcula)\b.*\bt[e\xe9]rminos?\b|\bt[e\xe9]rminos?\b.*(?:suma|total)/i.test(text)) return null;
        // Extract term count
        var nRe = /(?:primeros?\s+)?(\d+)\s+t[e\xe9]rminos?|n\s*=\s*(\d+)/i;
        var nM = nRe.exec(text);
        if (!nM) return null;
        var n = parseInt(nM[1] || nM[2], 10);
        if (!n || n < 2 || n > 10000) return null;
        // Find a sequence of 3+ numbers with consistent ratio
        var seqRe = /(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)(?:\s*,\s*(\d+\.?\d*))?/g;
        var m;
        while ((m = seqRe.exec(text)) !== null) {
            var vals = [m[1], m[2], m[3], m[4]].filter(Boolean).map(function(v) { return new Decimal(v); });
            if (vals.length < 3) continue;

            // Use MathEngine for robust geometric sequence detection
            var detected = MathEngine.detectGeometricSequence(vals);
            if (!detected) continue;

            // All checks passed: compute via MathEngine
            var seriesCalc = MathEngine.geometricSeries(detected.a1, detected.r, n);
            console.log('[MathVerify] Implicit geometric series detected: a1=' + detected.a1 + ', r=' + detected.r.toFixed(4) + ', n=' + n + ' → S_n=' + seriesCalc.value.toExponential(4));
            return {
                value: seriesCalc.value,
                steps: seriesCalc.steps,
                fromFormula: true,
            };
        }
        return null;
    }

    static _tryCombinedFormula(text) {
        // Detect "S₁ + S₂" patterns where S₁ and S₂ are named series
        var results = [];
        var steps = [];

        var summation = QuizMathValidator._tryPolynomialSummation(text);
        var geo = QuizMathValidator._tryGeometricSeriesFormula(text);
        // Also try implicit geometric (no keyword needed) and sigma-notation geometric
        if (!geo) geo = QuizMathValidator._tryImplicitGeometricSeries(text);
        if (!geo) geo = QuizMathValidator._trySigmaGeometricSeries(text);
        var arith = QuizMathValidator._tryArithmeticSeriesFormula(text);

        if (summation) { results.push(summation);
            steps = steps.concat(summation.steps); }
        if (arith && !summation) { results.push(arith);
            steps = steps.concat(arith.steps); }
        if (geo) { results.push(geo);
            steps = steps.concat(geo.steps); }

        if (results.length >= 2) {
            var total = results[0].value;
            for (var ci = 1; ci < results.length; ci++) {
                total = total.plus(results[ci].value);
            }
            steps.push('Total combinado: ' + results.map(function(r) { return r.value; }).join(' + ') + ' = ' + total);
            return { value: total, steps: steps, fromFormula: true };
        }

        // If only one formula was found, return it (single series)
        if (results.length === 1) return results[0];

        return null;
    }

    static _tryPolynomialSummation(text) {
        var sigmaPatterns = [
            /[\u03A3\u2211]\s*\(?(?:de\s+)?i\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(([^)]+)\)/i,
            /sumatoria\s*(?::\s*)?[\u03A3\u2211]?\s*\(?(?:de\s+)?i\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(([^)]+)\)/i,
            // LaTeX-like: Σ_{i=1}^{200} (7i - 12)
            /[\u03A3\u2211]\s*_?\{?\s*[ij]\s*=\s*(\d+)\s*\}?\s*\^?\{?\s*(\d+)\s*\}?\s*\(([^)]+)\)/i,
            // Alternate LaTeX: Σ_{i=1}^{n} expression without parens
            /[\u03A3\u2211]\s*_?\{?\s*[ij]\s*=\s*(\d+)\s*\}?\s*\^?\{?\s*(\d+)\s*\}?\s+(\d+\s*[ij](?:\s*[-+]\s*\d+)?)/i,
        ];
        for (var p = 0; p < sigmaPatterns.length; p++) {
            var m = sigmaPatterns[p].exec(text);
            if (!m) continue;
            var start = parseInt(m[1], 10);
            var end = parseInt(m[2], 10);
            var polyExpr = m[3];
            if (end < start || end - start > 100000) return null;
            var coeffs = QuizMathValidator._parsePolynomialCoefficients(polyExpr);
            if (!coeffs) return null;
            if (start !== 1 || end > 10000) {
                return QuizMathValidator._computeSummationByIteration(start, end, coeffs, polyExpr);
            }
            var n = new Decimal(end);
            var steps = [];
            var result = new Decimal(0);
            if (!coeffs.a3.isZero()) {
                var sumI3 = n.times(n.plus(1)).div(2).pow(2);
                var term3 = coeffs.a3.times(sumI3);
                result = result.plus(term3);
                steps.push(coeffs.a3 + '*SumI3 = ' + term3);
            }
            if (!coeffs.a2.isZero()) {
                var sumI2 = n.times(n.plus(1)).times(n.times(2).plus(1)).div(6);
                var term2 = coeffs.a2.times(sumI2);
                result = result.plus(term2);
                steps.push(coeffs.a2 + '*n(n+1)(2n+1)/6 = ' + term2);
            }
            if (!coeffs.a1.isZero()) {
                var sumI1 = n.times(n.plus(1)).div(2);
                var term1 = coeffs.a1.times(sumI1);
                result = result.plus(term1);
                steps.push(coeffs.a1 + '*n(n+1)/2 = ' + term1);
            }
            if (!coeffs.a0.isZero()) {
                var term0 = coeffs.a0.times(n);
                result = result.plus(term0);
                steps.push(coeffs.a0 + '*n = ' + term0);
            }
            steps.unshift('Sumatoria(i=1 a ' + end + ') de (' + polyExpr + ')');
            steps.push('Resultado sumatoria: ' + result);
            return { value: result, steps: steps, fromFormula: true };
        }
        return null;
    }

    static _parsePolynomialCoefficients(expr) {
        var s = expr.trim().replace(/i\xb3/g, 'i^3').replace(/i\xb2/g, 'i^2').replace(/\s+/g, ' ');
        if (/^[\di]/.test(s)) s = '+' + s;
        var result = { a3: new Decimal(0), a2: new Decimal(0), a1: new Decimal(0), a0: new Decimal(0) };
        var termRe = /([+-])\s*(\d*\.?\d*)\s*i\s*\^\s*(\d+)|([+-])\s*(\d*\.?\d*)\s*i(?!\s*\^)|([+-])\s*(\d+\.?\d*)/g;
        var m, matched = false;
        while ((m = termRe.exec(s)) !== null) {
            matched = true;
            if (m[1] !== undefined && m[3] !== undefined) {
                var sign1 = m[1] === '-' ? -1 : 1;
                var coeff1 = (m[2] === '' || m[2] === undefined) ? 1 : parseFloat(m[2]);
                var power = parseInt(m[3], 10);
                if (power <= 3) result['a' + power] = new Decimal(sign1 * coeff1);
            } else if (m[4] !== undefined) {
                var sign2 = m[4] === '-' ? -1 : 1;
                var coeff2 = (m[5] === '' || m[5] === undefined) ? 1 : parseFloat(m[5]);
                result.a1 = new Decimal(sign2 * coeff2);
            } else if (m[6] !== undefined) {
                var sign3 = m[6] === '-' ? -1 : 1;
                result.a0 = new Decimal(sign3 * parseFloat(m[7]));
            }
        }
        return matched ? result : null;
    }

    static _computeSummationByIteration(start, end, coeffs, polyExpr) {
        if (end - start + 1 > 100000) return null;
        var result = new Decimal(0);
        for (var i = start; i <= end; i++) {
            var di = new Decimal(i);
            result = result.plus(coeffs.a3.times(di.pow(3)).plus(coeffs.a2.times(di.pow(2))).plus(coeffs.a1.times(di)).plus(coeffs.a0));
        }
        return { value: result, steps: ['Sumatoria(i=' + start + ' a ' + end + ') = ' + result], fromFormula: true };
    }

    static _tryGeometricSeriesFormula(text) {
        if (!/serie\s+geom[e\xe9]trica|progresi[o\xf3]n\s+geom[e\xe9]trica|geom[e\xe9]tric/i.test(text)) return null;
        var a1, r, n;

        // Pattern A: Sigma notation — Σ_{j=1}^{25} 4·(3.2)^{j-1}
        var sigmaGeoRe = /[\u03A3\u2211]\s*_?\{?\s*[ij]\s*=\s*\d+\s*\}?\s*\^?\{?\s*(\d+)\s*\}?\s*(\d+\.?\d*)\s*[·*×\u00b7]\s*\(?(\d+\.?\d*)\)?\s*\^\s*\{?\s*(?:\(\s*)?[ij]\s*(?:-\s*1\s*(?:\))?\s*)?\}?/i;
        var sigmaM = sigmaGeoRe.exec(text);
        if (sigmaM) {
            n = parseInt(sigmaM[1], 10);
            a1 = new Decimal(sigmaM[2]);
            r = new Decimal(sigmaM[3]);
            if (a1.gt(0) && !r.eq(1) && n >= 1 && n <= 10000) {
                var seriesCalc = MathEngine.geometricSeries(a1, r, n);
                console.log('[MathVerify] Geometric series from sigma: a1=' + a1 + ', r=' + r + ', n=' + n + ' → S_n=' + seriesCalc.value.toExponential(4));
                return { value: seriesCalc.value, steps: seriesCalc.steps, fromFormula: true };
            }
        }

        // Pattern B: Sequence-based — "primeros 25 términos ... 4, 12, 36, 108"
        var seqRe = /(?:primeros?\s+)?(\d+)\s+t[e\xe9]rminos?[^.]*?(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)/i;
        var seqM = seqRe.exec(text);
        if (seqM) {
            n = parseInt(seqM[1], 10);
            a1 = new Decimal(seqM[2]);
            var second = new Decimal(seqM[3]);
            var third = new Decimal(seqM[4]);
            if (a1.isZero()) return null;
            r = second.div(a1);
            var r2 = third.div(second);
            if (!r.equals(r2)) return null;
        }
        if (!a1) {
            // Pattern C: Parameter-based — "a₁=4, r=3.2, n=25"
            var paramRe = /a[\u20811]\s*=\s*(\d+\.?\d*).*?r\s*=\s*(\d+\.?\d*)/i;
            var paramM = paramRe.exec(text);
            if (paramM) {
                a1 = new Decimal(paramM[1]);
                r = new Decimal(paramM[2]);
                var nRe2 = /(?:primeros?\s+)?(\d+)\s+t[e\xe9]rminos?|n\s*=\s*(\d+)/i;
                var nM = nRe2.exec(text);
                if (nM) n = parseInt(nM[1] || nM[2], 10);
            }
        }
        if (!a1 || !r || !n || r.eq(1) || n < 1) return null;
        var seriesCalc2 = MathEngine.geometricSeries(a1, r, n);
        return {
            value: seriesCalc2.value,
            steps: seriesCalc2.steps,
            fromFormula: true,
        };
    }

    static _tryArithmeticSeriesFormula(text) {
            if (!/serie\s+aritm[e\xe9]trica|progresi[o\xf3]n\s+aritm[e\xe9]trica/i.test(text)) return null;
            var a1, d, n;

            // Pattern A: Sigma with linear polynomial — Σ_{i=1}^{200} (7i - 12)
            var sigmaLinRe = /[\u03A3\u2211]\s*_?\{?\s*[ij]\s*=\s*(\d+)\s*\}?\s*\^?\{?\s*(\d+)\s*\}?\s*\(?(\d+\.?\d*)\s*[ij]\s*([+-]\s*\d+\.?\d*)?\)?/i;
            var sigmaM = sigmaLinRe.exec(text);
            if (sigmaM) {
                var start = parseInt(sigmaM[1], 10);
                var end = parseInt(sigmaM[2], 10);
                var slope = QuizMathValidator._parseDecimal(sigmaM[3]);
                var intercept = sigmaM[4] ? QuizMathValidator._parseDecimal(sigmaM[4].replace(/\s/g, '')) : new Decimal(0);
                if (slope && intercept !== null && end >= start) {
                    n = end - start + 1;
                    a1 = slope.times(start).plus(intercept);
                    d = slope;
                    var seriesCalc = MathEngine.arithmeticSeries(a1, d, n);
                    console.log('[MathVerify] Arithmetic series from sigma: a1=' + a1 + ', d=' + d +
                        ', n=' + n + ' → S=' + seriesCalc.value);
                    return { value: seriesCalc.value, steps: seriesCalc.steps, fromFormula: true };
                }
            }

            // Pattern B: Sequence-based
            var seqRe = /(?:primeros?\s+)?(\d+)\s+t[e\xe9]rminos?[^.]*?(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)/i;
            var seqM = seqRe.exec(text);
            if (seqM) {
                n = parseInt(seqM[1], 10);
                a1 = new Decimal(seqM[2]);
                var second = new Decimal(seqM[3]);
                var third = new Decimal(seqM[4]);
                d = second.minus(a1);
                if (!d.equals(third.minus(second))) return null;
            }
            if (!a1) {
                // Pattern C: Parameter-based
                var paramRe = /a[\u20811]\s*=\s*(\d+\.?\d*).*?d\s*=\s*(\d+\.?\d*)/i;
                var paramM = paramRe.exec(text);
                if (paramM) {
                    a1 = new Decimal(paramM[1]);
                    d = new Decimal(paramM[2]);
                    var nRe2 = /(?:primeros?\s+)?(\d+)\s+t[e\xe9]rminos?|n\s*=\s*(\d+)/i;
                    var nM = nRe2.exec(text);
                    if (nM) n = parseInt(nM[1] || nM[2], 10);
                }
            }
            if (!a1 || !d || !n || n < 1) return null;
            var seriesCalc2 = MathEngine.arithmeticSeries(a1, d, n);
            return {
                value: seriesCalc2.value,
                steps: seriesCalc2.steps,
                fromFormula: true,
            };
        }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 2.4: Sigma-notation Geometric Series (no keyword required)
    // Detects: Σ(a·r^{k-1}), Σ(a·r^k), Σ_{k=1}^{n} a·r^{k-1}
    // This catches cases where the problem uses sigma notation for a geometric
    // series without explicitly saying "serie geométrica".
    // ═══════════════════════════════════════════════════════════════════════════

    static _trySigmaGeometricSeries(text) {
        // Pattern: Σ_{k=start}^{end} a·r^{k-1} or a·r^k or a(r)^{k-1}
        var sigmaGeoPatterns = [
            // Σ_{k=1}^{50} 3·2^{k-1}  or  Σ(k=1 to 50) 3·2^{k-1}
            /[\u03A3\u2211]\s*_?\{?\s*[ijk]\s*=\s*(\d+)\s*\}?\s*\^?\{?\s*(\d+)\s*\}?\s*\(?\s*(\d+\.?\d*)\s*[·*×\u00b7]\s*\(?(\d+\.?\d*)\)?\s*\^\s*\{?\s*(?:\(\s*)?[ijk]\s*(?:-\s*1\s*(?:\))?\s*)?\}?\s*\)?/i,
            // Σ(de k=1 a 50) de (3·2^{k-1})
            /[\u03A3\u2211]\s*\(?(?:de\s+)?[ijk]\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(?\s*(\d+\.?\d*)\s*[·*×\u00b7]\s*\(?(\d+\.?\d*)\)?\s*\^\s*\{?\s*(?:\(\s*)?[ijk]\s*(?:-\s*1\s*(?:\))?\s*)?\}?\s*\)?/i,
            // sumatoria de k=1 a 50 de 3·2^{k-1}
            /sumatoria\s*(?::\s*)?[\u03A3\u2211]?\s*\(?(?:de\s+)?[ijk]\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(?\s*(\d+\.?\d*)\s*[·*×\u00b7]\s*\(?(\d+\.?\d*)\)?\s*\^\s*\{?\s*(?:\(\s*)?[ijk]\s*(?:-\s*1\s*(?:\))?\s*)?\}?\s*\)?/i,
        ];
        for (var p = 0; p < sigmaGeoPatterns.length; p++) {
            var m = sigmaGeoPatterns[p].exec(text);
            if (!m) continue;
            var start = parseInt(m[1], 10);
            var end = parseInt(m[2], 10);
            var a1 = new Decimal(m[3]);
            var r = new Decimal(m[4]);
            if (a1.gt(0) && !r.eq(1) && end >= start && end <= 100000) {
                var n = end - start + 1;
                var seriesCalc = MathEngine.geometricSeries(a1, r, n);
                console.log('[MathVerify] Sigma geometric series: a1=' + a1 + ', r=' + r + ', n=' + n + ' → S_n=' + seriesCalc.value.toExponential(4));
                return { value: seriesCalc.value, steps: seriesCalc.steps, fromFormula: true };
            }
        }
        return null;
    }

        // ═══════════════════════════════════════════════════════════════════════════
        // Strategy 3: Compound multi-step problems (multiple qty×price pairs)
        // e.g. "3 libros a $50 y 5 cuadernos a $20" → 3×50 + 5×20 = 250
        // ═══════════════════════════════════════════════════════════════════════════

    static _tryCompoundProblem(text) {
        var steps = [];
        var result;

        // Detect multiple qty×price item groups in a single problem
        var multiItemRe = /(\d[\d,.]*)\s*(?:unidades?|art[i\xed]culos?|productos?|cajas?|paquetes?|boletos?|entradas?|libros?|piezas?|docenas?|elementos?|sillas?|mesas?|computadoras?|tel[e\xe9]fonos?|equipos?|porciones?|lotes?|kilos?|litros?|galones?|toneladas?|sacos?|bultos?|rollos?|bolsas?|botellas?|metros?|cuadernos?|l[a\xe1]pices?|camisas?|pantalones?|zapatos?|camisetas?|gorras?|balones?|juguetes?|herramientas?|plantas?|\w+s)\s+(?:a|de|por|con\s+(?:un\s+)?(?:costo|precio|valor)\s+(?:de|unitario)?)\s*\$?\s*([\d,.]+)(?:\s*(?:cada\s+(?:uno|una)|c\/u|por\s+(?:unidad|pieza)))?/gi;
        var matches = [];
        var mm;
        while ((mm = multiItemRe.exec(text)) !== null) {
            var q = QuizMathValidator._parseDecimal(mm[1]);
            var p = QuizMathValidator._parseDecimal(mm[2]);
            if (q && p && q.gt(0) && p.gt(0)) {
                matches.push({ qty: q, price: p, raw: mm[0] });
            }
        }
        if (matches.length >= 2) {
            result = new Decimal(0);
            for (var i = 0; i < matches.length; i++) {
                var subtotal = matches[i].qty.times(matches[i].price);
                result = result.plus(subtotal);
                steps.push(matches[i].qty + ' \xd7 ' + matches[i].price + ' = ' + subtotal);
            }
            steps.push('Total = ' + result);
            // Apply follow-up operations (discount, tax, etc.)
            result = QuizMathValidator._applyPercentage(text, result, steps);
            result = QuizMathValidator._applyPostSubtraction(text, result, [], steps);
            result = QuizMathValidator._applyPostAddition(text, result, [], steps);
            return { value: result, steps: steps };
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 4: Multiplication / Rate / Area problems
    // Detects problems where two or more numbers should be MULTIPLIED, not summed.
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryMultiplicationProblem(text) {
        var lower = text.toLowerCase();
        var steps = [];
        var result;

        // ─── Pattern A: Area ─────────────────────────────────────────────────
        // "área de un rectángulo con base 5 y altura 3" → 5 × 3 = 15
        var areaPatterns = [
            /[a\xe1]rea[\s\S]{0,120}?(?:base|largo|longitud)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)(?:\s*(?:cm|m|km|mm|in|ft|metros?|cent[i\xed]metros?|pulgadas?))?[\s\S]{0,60}?(?:altura|ancho|anchura|alto)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)/i,
            /(?:base|largo|longitud)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)(?:\s*(?:cm|m|km|mm|in|ft|metros?|cent[i\xed]metros?|pulgadas?))?[\s\S]{0,60}?(?:altura|ancho|anchura|alto)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)[\s\S]{0,80}?[a\xe1]rea/i,
            /[a\xe1]rea[\s\S]{0,120}?(?:altura|ancho|anchura|alto)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)(?:\s*(?:cm|m|km|mm|in|ft|metros?))?[\s\S]{0,60}?(?:base|largo|longitud)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)/i,
            /(?:rect[a\xe1]ngulo|terreno|parcela|sala|habitaci[o\xf3]n|piso|campo|jard[i\xed]n|muro|pared|ventana|puerta|tela|techo|lona|alfombra)[\s\S]{0,80}?(?:mide|dimensiones?|de)\s*([\d,.]+)\s*(?:cm|m|km|mm|metros?)?\s*(?:por|x|\xd7|de)\s*([\d,.]+)/i,
        ];
        for (var ai = 0; ai < areaPatterns.length; ai++) {
            var am = areaPatterns[ai].exec(text);
            if (am) {
                var a = QuizMathValidator._parseDecimal(am[1]);
                var b = QuizMathValidator._parseDecimal(am[2]);
                if (a && b && a.gt(0) && b.gt(0)) {
                    result = a.times(b);
                    steps.push('\xc1rea = ' + a + ' \xd7 ' + b + ' = ' + result);
                    result = QuizMathValidator._applyPercentage(text, result, steps);
                    return { value: result, steps: steps };
                }
            }
        }

        // ─── Pattern B: Volume ───────────────────────────────────────────────
        // "volumen de un prisma 5 × 3 × 2" → 30
        var volumePatterns = [
            /volumen.*?([\d,.]+)\s*(?:cm|m|km|mm|metros?|x|\xd7|por)\s*(?:de\s+)?([\d,.]+)\s*(?:cm|m|km|mm|metros?|x|\xd7|por)\s*(?:de\s+)?([\d,.]+)/i,
            /([\d,.]+)\s*(?:cm|m|km|mm|metros?|x|\xd7|por)\s*(?:de\s+)?([\d,.]+)\s*(?:cm|m|km|mm|metros?|x|\xd7|por)\s*(?:de\s+)?([\d,.]+)(?:\s*\w+){0,6}?volumen/i,
        ];
        for (var vi = 0; vi < volumePatterns.length; vi++) {
            var vm = volumePatterns[vi].exec(text);
            if (vm) {
                var va = QuizMathValidator._parseDecimal(vm[1]);
                var vb = QuizMathValidator._parseDecimal(vm[2]);
                var vc = QuizMathValidator._parseDecimal(vm[3]);
                if (va && vb && vc && va.gt(0) && vb.gt(0) && vc.gt(0)) {
                    result = va.times(vb).times(vc);
                    steps.push('Volumen = ' + va + ' \xd7 ' + vb + ' \xd7 ' + vc + ' = ' + result);
                    return { value: result, steps: steps };
                }
            }
        }

        // ─── Pattern C: Quantity × Unit Price (most common word problem) ─────
        // "5 artículos a $200 cada uno" → 5 × 200 = 1000
        // "compró 12 libros de $50" → 12 × 50 = 600
        var qtyPricePatterns = [
            // "N unidades/artículos a $X" or "N unidades con costo de $X"
            /(\d[\d,.]*)\s*(?:unidades?|art[i\xed]culos?|productos?|cajas?|paquetes?|boletos?|entradas?|libros?|piezas?|docenas?|elementos?|sillas?|mesas?|computadoras?|tel[e\xe9]fonos?|equipos?|porciones?|lotes?|kilos?|litros?|galones?|toneladas?|sacos?|bultos?|rollos?|bolsas?|botellas?|cuadernos?|l[a\xe1]pices?|camisas?|pantalones?|zapatos?|camisetas?|gorras?|balones?|juguetes?|herramientas?|plantas?)\s*(?:a\s+(?:un\s+)?(?:costo|precio|valor)\s+(?:de|unitario)\s*)?\$?\s*([\d,.]+)(?:\s*(?:cada\s+(?:uno|una)|c\/u|por\s+(?:unidad|art[i\xed]culo|pieza)))?/i,
            // "N unidades a/de/por $X"
            /(\d[\d,.]*)\s*(?:unidades?|art[i\xed]culos?|productos?|cajas?|paquetes?|boletos?|entradas?|libros?|piezas?|elementos?|sillas?|mesas?|cuadernos?)\s+(?:a|de|por)\s*\$?\s*([\d,.]+)/i,
            // "compró/vendió/fabricó N ... a/de/por $X"
            /(?:compr[a\xf3oe]|vend[ei\xf3a]|adquir[ei\xf3]|pag[a\xf3oe]|pidi[o\xf3]|orden[a\xf3oe]|fabric[a\xf3oe]|produj[oe]|elabor[a\xf3e]|manufactur[a\xf3oe]|contrat[a\xf3oe])\s+(\d[\d,.]*)\s+(?:\w+\s+){0,4}?(?:a|de|por|con\s+(?:un\s+)?(?:costo|precio|valor)\s+(?:de)?)\s*\$?\s*([\d,.]+)/i,
            // "N horas/días/meses a $X la hora/día"
            /(\d[\d,.]*)\s*(?:horas?|d[i\xed]as?|meses?|semanas?|a[n\xf1]os?|minutos?|turnos?|jornadas?)\s*(?:a|de|por|con\s+(?:un\s+)?(?:salario|sueldo|pago|tarifa|costo|cobro)\s+(?:de)?)\s*\$?\s*([\d,.]+)/i,
            // "N GB/kg/litros a $X por GB/kg/litro"
            /(\d[\d,.]*)\s*(?:GB|MB|TB|kg|g|litros?|metros?|km|ml|lb|toneladas?|kWh|megabytes?|gigabytes?|terabytes?)\s*(?:a|de|por|con\s+un\s+costo\s+de)\s*\$?\s*([\d,.]+)\s*(?:por|\/)\s*(?:GB|MB|TB|kg|g|litro|metro|km|kWh)/i,
            // reversed: "$X por unidad ... N unidades"
            /\$\s*([\d,.]+)\s*(?:por|\/)\s*(?:unidad|art[i\xed]culo|pieza|hora|d[i\xed]a|mes|GB|kg|litro|kWh|metro)[\s\S]{0,80}?(\d[\d,.]*)\s*(?:unidades?|art[i\xed]culos?|piezas?|horas?|d[i\xed]as?|meses?|GB|kg|litros?|kWh|metros?)/i,
        ];
        for (var qi = 0; qi < qtyPricePatterns.length; qi++) {
            var qm = qtyPricePatterns[qi].exec(text);
            if (qm) {
                var qty = QuizMathValidator._parseDecimal(qm[1]);
                var price = QuizMathValidator._parseDecimal(qm[2]);
                if (qty && price && qty.gt(0) && price.gt(0)) {
                    result = qty.times(price);
                    steps.push('Cantidad \xd7 Precio unitario = ' + qty + ' \xd7 ' + price + ' = ' + result);
                    result = QuizMathValidator._applyPercentage(text, result, steps);
                    result = QuizMathValidator._applyPostSubtraction(text, result, [qty, price], steps);
                    result = QuizMathValidator._applyPostAddition(text, result, [qty, price], steps);
                    return { value: result, steps: steps };
                }
            }
        }

        // ─── Pattern D: Workers/employees × salary ───────────────────────────
        // "5 trabajadores ganan $500 al mes" → 5 × 500 = 2500
        var workerPatterns = [
            /(\d[\d,.]*)\s*(?:trabajadores?|empleados?|personas?|obreros?|estudiantes?|socios?|miembros?|vendedores?|t[e\xe9]cnicos?|ingenieros?|profesores?|maestros?|doctores?|enfermeros?|operarios?|agentes?)[\s\S]{0,60}?(?:gana[rn]?|recib[eir]+n?|cobra[rn]?|produce[n]?|aporta[rn]?|paga[rn]?)\s*(?:cada\s+(?:uno|una)\s+)?\$?\s*([\d,.]+)/i,
            /(\d[\d,.]*)\s*(?:trabajadores?|empleados?|personas?|obreros?)[\s\S]{0,60}?(?:sueldo|salario|ingreso|pago)\s*(?:de|=|:)?\s*\$?\s*([\d,.]+)/i,
        ];
        for (var wi = 0; wi < workerPatterns.length; wi++) {
            var wm = workerPatterns[wi].exec(text);
            if (wm) {
                var workers = QuizMathValidator._parseDecimal(wm[1]);
                var salary = QuizMathValidator._parseDecimal(wm[2]);
                if (workers && salary && workers.gt(0) && salary.gt(0)) {
                    result = workers.times(salary);
                    steps.push('Personas \xd7 Monto = ' + workers + ' \xd7 ' + salary + ' = ' + result);
                    result = QuizMathValidator._applyPercentage(text, result, steps);
                    return { value: result, steps: steps };
                }
            }
        }

        // ─── Pattern E: Generic "X por Y" when context says multiplication ──
        if (/multiplic|producto\s+de|por\s+cada|veces/i.test(lower)) {
            var multRe = /([\d,.]+)\s*(?:por|\xd7|x|veces)\s*([\d,.]+)/i;
            var multM = multRe.exec(text);
            if (multM) {
                var ma = QuizMathValidator._parseDecimal(multM[1]);
                var mb = QuizMathValidator._parseDecimal(multM[2]);
                if (ma && mb && ma.gt(0) && mb.gt(0)) {
                    result = ma.times(mb);
                    steps.push('Multiplicaci\xf3n = ' + ma + ' \xd7 ' + mb + ' = ' + result);
                    result = QuizMathValidator._applyPercentage(text, result, steps);
                    return { value: result, steps: steps };
                }
            }
        }

        // ─── Pattern F: Perimeter ────────────────────────────────────────────
        // "perímetro de un rectángulo con base 5 y altura 3" → 2×(5+3) = 16
        if (/per[i\xed]metro/i.test(lower)) {
            var perimPatterns = [
                /per[i\xed]metro[\s\S]{0,120}?(?:base|largo|longitud|lado)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)(?:\s*(?:cm|m|km|mm|metros?))?[\s\S]{0,60}?(?:altura|ancho|anchura|alto|lado)\s*(?:de|=|:|es)?\s*\$?\s*([\d,.]+)/i,
            ];
            for (var pi = 0; pi < perimPatterns.length; pi++) {
                var pm = perimPatterns[pi].exec(text);
                if (pm) {
                    var pa = QuizMathValidator._parseDecimal(pm[1]);
                    var pb = QuizMathValidator._parseDecimal(pm[2]);
                    if (pa && pb && pa.gt(0) && pb.gt(0)) {
                        result = pa.plus(pb).times(2);
                        steps.push('Per\xedmetro = 2 \xd7 (' + pa + ' + ' + pb + ') = ' + result);
                        return { value: result, steps: steps };
                    }
                }
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 5: Percentage-of-base problems
    // "15% de 200" → 30, "$1000 con descuento del 20%" → 800
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryPercentageProblem(text) {
        var lower = text.toLowerCase();
        var steps = [];
        var result;

        // ─── Pattern A: "X% de Y" → Y × X/100 ──────────────────────────────
        var pctOfPatterns = [
            /([\d,.]+)\s*%\s*(?:de|del|sobre)\s*\$?\s*([\d,.]+)/i,
            /(?:el|un|una)?\s*([\d,.]+)\s*(?:por\s*ciento|%)\s*(?:de|del|sobre)\s*\$?\s*([\d,.]+)/i,
        ];
        for (var i = 0; i < pctOfPatterns.length; i++) {
            var m = pctOfPatterns[i].exec(text);
            if (m) {
                var pct = QuizMathValidator._parseDecimal(m[1]);
                var base = QuizMathValidator._parseDecimal(m[2]);
                if (pct && base && pct.gt(0) && base.gt(0)) {
                    result = base.times(pct).div(100);
                    steps.push(pct + '% de ' + base + ' = ' + base + ' \xd7 ' + pct + '/100 = ' + result);
                    return { value: result, steps: steps };
                }
            }
        }

        // ─── GUARD: If there are multiple currency values that must be summed
        // first (e.g. Q1=$X, Q2=$Y, Q3=$Z, Q4=$W ... descuento 20%), skip
        // discount/tax patterns and let Strategy 9 (_tryExplicitSumProblem) handle
        // the sum-then-percentage flow. This prevents applying the discount to
        // only one of the values (Bug: partial data usage).
        var allCurrencyVals = [];
        var currScan = /\$\s*([\d,.]+)/g;
        var currM;
        while ((currM = currScan.exec(text)) !== null) {
            var cv = QuizMathValidator._parseDecimal(currM[1]);
            if (cv && cv.gt(0)) allCurrencyVals.push(cv);
        }
        var hasMultipleSummableValues = allCurrencyVals.length >= 3;
        // Also check for labeled amounts (Q1: valor, Q2: valor, etc.)
        if (!hasMultipleSummableValues) {
            var labelScan = /(?:Q\d|trimestre|mes|semana|periodo|cuota|pago)\s*(?:\d+)?\s*[:=]\s*\$?\s*([\d,.]+)/gi;
            var labelCount = 0;
            while (labelScan.exec(text) !== null) labelCount++;
            hasMultipleSummableValues = labelCount >= 3;
        }

        // ─── Pattern B: Discount on a value ──────────────────────────────────
        // "$1000 con descuento del 20%" → 800 (final price) or 200 (discount amount)
        // SKIP if multiple values need summing first (let Strategy 9 handle it)
        if (!hasMultipleSummableValues) {
        var discountPatterns = [
            /\$?\s*([\d,.]+)[\s\S]{0,80}?(?:descuento|rebaja)\s+(?:del?)?\s*([\d,.]+)\s*%/i,
            /(?:descuento|rebaja)\s+(?:del?)?\s*([\d,.]+)\s*%[\s\S]{0,80}?\$?\s*([\d,.]+)/i,
        ];
        for (var di = 0; di < discountPatterns.length; di++) {
            var dm = discountPatterns[di].exec(text);
            if (dm) {
                var dBase, dPct;
                if (di === 0) {
                    dBase = QuizMathValidator._parseDecimal(dm[1]);
                    dPct = QuizMathValidator._parseDecimal(dm[2]);
                } else {
                    dPct = QuizMathValidator._parseDecimal(dm[1]);
                    dBase = QuizMathValidator._parseDecimal(dm[2]);
                }
                if (dBase && dPct && dBase.gt(0) && dPct.gt(0) && dPct.lte(100)) {
                    if (/precio\s+final|costo\s+final|pagar[a\xe1]?s?|total|valor\s+final|queda|despu[e\xe9]s/i.test(lower)) {
                        var factor = new Decimal(1).minus(dPct.div(100));
                        result = dBase.times(factor);
                        steps.push('Descuento ' + dPct + '% sobre ' + dBase + ': ' + dBase + ' \xd7 ' + factor + ' = ' + result);
                    } else {
                        // Default: return discounted price (more common question)
                        var factor2 = new Decimal(1).minus(dPct.div(100));
                        result = dBase.times(factor2);
                        steps.push('Precio con descuento ' + dPct + '%: ' + dBase + ' \xd7 ' + factor2 + ' = ' + result);
                    }
                    return { value: result, steps: steps };
                }
            }
        }
        } // end if (!hasMultipleSummableValues) for discount

        // ─── Pattern C: Tax / increment on a value ───────────────────────────
        // "$1000 con IVA del 16%" → 1160
        // SKIP if multiple values need summing first (let Strategy 9 handle it)
        if (!hasMultipleSummableValues) {
        var taxPatterns = [
            /\$?\s*([\d,.]+)[\s\S]{0,80}?(?:impuesto|IVA|ISR|recargo|inter[e\xe9]s|incremento|aumento)(?:\s+\w+){0,3}?\s+(?:del?)?\s*([\d,.]+)\s*%/i,
            /(?:impuesto|IVA|ISR|recargo|inter[e\xe9]s|incremento|aumento)(?:\s+\w+){0,3}?\s+(?:del?)?\s*([\d,.]+)\s*%[\s\S]{0,80}?\$?\s*([\d,.]+)/i,
        ];
        for (var ti = 0; ti < taxPatterns.length; ti++) {
            var tm = taxPatterns[ti].exec(text);
            if (tm) {
                var tBase, tPct;
                if (ti === 0) {
                    tBase = QuizMathValidator._parseDecimal(tm[1]);
                    tPct = QuizMathValidator._parseDecimal(tm[2]);
                } else {
                    tPct = QuizMathValidator._parseDecimal(tm[1]);
                    tBase = QuizMathValidator._parseDecimal(tm[2]);
                }
                if (tBase && tPct && tBase.gt(0) && tPct.gt(0) && tPct.lte(200)) {
                    // Determine if this is a deductible tax (corporate, income, ISR)
                    var isTaxDeduction = /corporativ|sobre\s+(?:la\s+)?renta|retenci[o\xf3]n|ISR/i.test(text) ||
                                         /despu[e\xe9]s\s+de\s+impuestos?|neto\b/i.test(lower);
                    if (isTaxDeduction) {
                        var tDedFactor = new Decimal(1).minus(tPct.div(100));
                        result = tBase.times(tDedFactor);
                        steps.push('Impuesto ' + tPct + '% (deducci\xf3n) sobre ' + tBase + ': ' + tBase + ' \xd7 ' + tDedFactor + ' = ' + result);
                    } else if (/precio\s+final|costo\s+final|total|pagar[a\xe1]?s?|monto\s+total|valor\s+final|monto\s+final/i.test(lower)) {
                        var tfactor = new Decimal(1).plus(tPct.div(100));
                        result = tBase.times(tfactor);
                        steps.push(tPct + '% impuesto sobre ' + tBase + ': ' + tBase + ' \xd7 ' + tfactor + ' = ' + result);
                    } else {
                        // Default: return total with tax (most common)
                        var tfactor2 = new Decimal(1).plus(tPct.div(100));
                        result = tBase.times(tfactor2);
                        steps.push('Total con ' + tPct + '% impuesto: ' + tBase + ' \xd7 ' + tfactor2 + ' = ' + result);
                    }
                    return { value: result, steps: steps };
                }
            }
        }
        } // end if (!hasMultipleSummableValues) for tax

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 6: Division problems
    // "repartir 100 entre 4" → 25, "dividir 500 entre 5" → 100
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryDivisionProblem(text) {
        var steps = [];
        var result;

        var divPatterns = [
            // "repartir/dividir/reparten $X entre Y personas" (all conjugations)
            /(?:repart|divid|distribu|separ)\w*\s+\$?\s*([\d,.]+)[\s\S]{0,60}?(?:entre|en)\s+(\d[\d,.]*)\s*(?:personas?|partes?|grupos?|equipos?|porciones?|participantes?|miembros?|secciones?|estudiantes?|alumnos?|trabajadores?|empleados?)?/i,
            // "X dividido entre/por Y"
            /\$?\s*([\d,.]+)\s*(?:dividido|partido)\s+(?:entre|por|en)\s*\$?\s*([\d,.]+)/i,
            // "$X se divide/reparte entre Y"
            /\$?\s*([\d,.]+)[\s\S]{0,40}?(?:divid|repart|distribuy)\w*[\s\S]{0,40}?(?:entre|en)\s+(\d[\d,.]*)/i,
            // "cuánto le toca si $X entre Y"
            /(?:\xbfcu[a\xe1]nto|cuanto)[\s\S]{0,40}?\$?\s*([\d,.]+)[\s\S]{0,40}?(?:entre|por)\s+(\d[\d,.]*)/i,
        ];
        for (var i = 0; i < divPatterns.length; i++) {
            var m = divPatterns[i].exec(text);
            if (m) {
                var dividend = QuizMathValidator._parseDecimal(m[1]);
                var divisor = QuizMathValidator._parseDecimal(m[2]);
                if (dividend && divisor && divisor.gt(0)) {
                    result = dividend.div(divisor);
                    steps.push('Divisi\xf3n = ' + dividend + ' \xf7 ' + divisor + ' = ' + result);
                    return { value: result, steps: steps };
                }
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 7: Average / Mean problems
    // "promedio de 10, 20, 30" → 20
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryAverageProblem(text) {
        if (!/promedio|media\b|average|mean\b/i.test(text)) return null;

        var steps = [];

        // Find where the keyword ends and extract numbers after it
        var keywordMatch = text.match(/(?:promedio|media|average|mean)\s*(?:de\s*)?(?:los\s+)?(?:n[u\xfa]meros?\s*)?(?::|es|son|de)?\s*/i);
        if (keywordMatch) {
            var afterKeyword = text.substring(keywordMatch.index + keywordMatch[0].length);
            // Extract all numbers from the list portion (stop at non-number/non-separator)
            var nums = [];
            var scanRe = /(\d+(?:,\d{3})*\.?\d*)\s*(?:[,;]\s*|\s+y\s+)?/gi;
            var sm;
            while ((sm = scanRe.exec(afterKeyword)) !== null) {
                var d = QuizMathValidator._parseDecimal(sm[1]);
                if (d) nums.push(d);
            }
            if (nums.length >= 2) {
                var sum = nums.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
                var avg = sum.div(nums.length);
                steps.push('Suma: ' + nums.join(' + ') + ' = ' + sum);
                steps.push('Promedio: ' + sum + ' / ' + nums.length + ' = ' + avg);
                return { value: avg, steps: steps };
            }
        }

        // Fallback: extract labeled data numbers for average
        var dataNumbers = QuizMathValidator._extractDataNumbers(text);
        if (dataNumbers.length >= 2) {
            var sum2 = dataNumbers.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
            var avg2 = sum2.div(dataNumbers.length);
            steps.push('Datos: ' + dataNumbers.join(', '));
            steps.push('Suma: ' + dataNumbers.join(' + ') + ' = ' + sum2);
            steps.push('Promedio: ' + sum2 + ' / ' + dataNumbers.length + ' = ' + avg2);
            return { value: avg2, steps: steps };
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 8: Simple Interest / Compound Interest
    // "capital $1000, tasa 5%, tiempo 3 años" → I = C × r × t
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryInterestProblem(text) {
        var lower = text.toLowerCase();
        if (!/inter[e\xe9]s\s+(?:simple|compuesto)|capital.*tasa.*tiempo|tasa.*inter[e\xe9]s/i.test(lower)) return null;

        var steps = [];
        var result;

        // Extract capital, rate, time
        var capitalMatch = text.match(/(?:capital|monto|inversi[o\xf3]n|principal|pr[e\xe9]stamo|deuda)\s*(?:de|=|:|es|inicial)?\s*\$?\s*([\d,.]+)/i);
        var rateMatch = text.match(/(?:tasa|inter[e\xe9]s|raz[o\xf3]n)\s*(?:de|=|:|es|del?)?\s*([\d,.]+)\s*%/i);
        var timeMatch = text.match(/(?:tiempo|durante|plazo|per[i\xed]odo)\s*(?:de|=|:|es)?\s*([\d,.]+)\s*(?:a[n\xf1]os?|meses?|d[i\xed]as?|semestres?|trimestres?|bimestres?)/i);

        if (!capitalMatch || !rateMatch || !timeMatch) return null;

        var capital = QuizMathValidator._parseDecimal(capitalMatch[1]);
        var rate = QuizMathValidator._parseDecimal(rateMatch[1]);
        var time = QuizMathValidator._parseDecimal(timeMatch[1]);

        if (!capital || !rate || !time || capital.lte(0) || rate.lte(0) || time.lte(0)) return null;

        if (/inter[e\xe9]s\s+compuesto|compuesto/i.test(lower)) {
            // Compound interest via MathEngine
            var compound = MathEngine.compoundInterest(capital, rate, time);
            if (/inter[e\xe9]s\s+(?:generado|ganado|acumulado|total)/i.test(lower)) {
                result = compound.interest;
                steps = compound.steps.concat(['Interés generado: ' + compound.interest]);
            } else {
                result = compound.total;
                steps = compound.steps;
            }
        } else {
            // Simple interest via MathEngine
            var simple = MathEngine.simpleInterest(capital, rate, time);
            if (/monto\s+(?:total|final)|total|pagar[a\xe1]?|acumulado/i.test(lower)) {
                result = simple.total;
                steps = simple.steps;
            } else {
                result = simple.interest;
                steps = simple.steps;
            }
        }

        return { value: result, steps: steps };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 9: Conservative Explicit Sum
    // ONLY triggers for problems that EXPLICITLY ask to add listed values.
    // NEVER blindly sums all numbers from the text.
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryExplicitSumProblem(text) {
        var lower = text.toLowerCase();

        // Only trigger for EXPLICITLY stated sums — not any question with numbers
        if (!/(?:suma\s+(?:de|total|los)|total\s+de|(?:\xbf)?cu[a\xe1]nto\s+(?:suman|es\s+(?:la\s+)?suma)|acumulad[oa]|calcula\s+(?:la\s+)?suma|sumando|cu[a\xe1]nto\s+gast[o\xf3]|cu[a\xe1]nto\s+pag[o\xf3]|gasto\s+total|costo\s+total|precio\s+total|monto\s+total|monto\s+final|valor\s+total|valor\s+final|ingreso\s+total|ingreso\s+anual|ingresos?\s+trimestrales?|deuda\s+total)/i.test(lower)) {
            return null;
        }

        // Don't trigger if text has multiplication/division/rate/percentage signals
        // Those should be handled by more specific strategies
        if (/multiplic|\xd7|\xf7|repartir|dividir|(?:base|largo)\s*(?:de|=|:)?\s*[\d]|(?:art[i\xed]culos?|unidades?|productos?)\s+(?:a|de|por)\s*\$/i.test(lower)) {
            return null;
        }

        var steps = [];
        var result;

        // ─── Pattern A: Currency list ────────────────────────────────────────
        // "$100, $200 y $300" or "$100 + $200 + $300"
        var allCurrencies = [];
        var currRe = /\$\s*([\d,.]+)/g;
        var crm;
        while ((crm = currRe.exec(text)) !== null) {
            var cv = QuizMathValidator._parseDecimal(crm[1]);
            if (cv && cv.gt(0)) allCurrencies.push(cv);
        }
        if (allCurrencies.length >= 2) {
            // Ensure these are similar-magnitude values (not qty×price pairs)
            var sorted = allCurrencies.slice().sort(function(a, b) { return a.cmp(b); });
            var maxC = sorted[sorted.length - 1];
            var minC = sorted[0];
            if (maxC.div(Decimal.max(minC, 1)).lte(100)) {
                var subtractionNums = QuizMathValidator._extractSubtractionNumbers(text);
                var addNums = subtractionNums.length > 0 ?
                    allCurrencies.filter(function(n) { return !subtractionNums.some(function(s) { return s.equals(n); }); }) :
                    allCurrencies;
                result = addNums.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
                steps.push('Suma: ' + addNums.map(function(n) { return '$' + n; }).join(' + ') + ' = $' + result);
                for (var si = 0; si < subtractionNums.length; si++) {
                    var prev = result;
                    result = result.minus(subtractionNums[si]);
                    steps.push('Resta: ' + prev + ' - ' + subtractionNums[si] + ' = ' + result);
                }
                result = QuizMathValidator._applyPercentage(text, result, steps);
                return { value: result, steps: steps };
            }
        }

        // ─── Pattern B: Labeled amounts ──────────────────────────────────────
        // "alquiler: $500, comida: $300, transporte: $100"
        var labeledAmounts = [];
        var labelRe = /(?:[a-zA-Z\xe1\xe9\xed\xf3\xfa\xf1\xc1\xc9\xcd\xd3\xda\xd1\s]+[:=]\s*)\$?\s*([\d,.]+)/gi;
        var lm;
        while ((lm = labelRe.exec(text)) !== null) {
            var lv = QuizMathValidator._parseDecimal(lm[1]);
            if (lv && lv.gte(1)) labeledAmounts.push(lv);
        }
        if (labeledAmounts.length >= 3) {
            // Verify similar magnitude
            var sortedL = labeledAmounts.slice().sort(function(a, b) { return a.cmp(b); });
            if (sortedL[sortedL.length - 1].div(Decimal.max(sortedL[0], 1)).lte(100)) {
                result = labeledAmounts.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
                steps.push('Suma: ' + labeledAmounts.join(' + ') + ' = ' + result);
                result = QuizMathValidator._applyPercentage(text, result, steps);
                return { value: result, steps: steps };
            }
        }

        // ─── Pattern C: Explicit "suma de N, N, N" ──────────────────────────
        // Uses thousands-separator-aware extraction to avoid confusing commas
        // inside numbers (e.g. 12,345,678) with commas separating list items.
        var sumKeyRe = /(?:suma|total)\s+(?:de\s+)?(?:los\s+)?(?:n[u\xfa]meros?|valores?|cantidades?|pagos?|gastos?|ingresos?)?\s*(?::|es)?\s*/i;
        var skm = sumKeyRe.exec(text);
        if (skm) {
            var afterKey = text.substring(skm.index + skm[0].length);
            // Extract numbers using thousands-separator-aware regex:
            // \d{1,3}(,\d{3})+ handles comma-formatted numbers (requires at least one comma group)
            // \d+ handles plain numbers without commas
            // Both optionally followed by .\d+ for decimals
            var thousNumRe = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
            var nums = [];
            var tnm;
            while ((tnm = thousNumRe.exec(afterKey)) !== null) {
                var nd = QuizMathValidator._parseDecimal(tnm[0]);
                if (nd) nums.push(nd);
            }
            if (nums.length >= 2) {
                result = nums.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
                steps.push('Suma: ' + nums.join(' + ') + ' = ' + result);
                return { value: result, steps: steps };
            }
        }

        // ─── Pattern D: Conservative data number sum ─────────────────────────
        // Only if we have labeled data AND all numbers are in similar range
        var subNums = QuizMathValidator._extractSubtractionNumbers(text);
        var dataNums = QuizMathValidator._extractDataNumbers(text);

        if (dataNums.length >= 2 && dataNums.length <= 8) {
            var sortedD = dataNums.slice().sort(function(a, b) { return a.cmp(b); });
            var maxVal = sortedD[sortedD.length - 1];
            var minVal = sortedD[0];
            // CRITICAL GUARD: If largest is >50× smallest, numbers likely have different roles
            // e.g. "5 artículos a $200" → 5 and 200 should NOT be summed
            if (maxVal.div(Decimal.max(minVal, 1)).gt(50)) return null;

            var addNumbers = subNums.length > 0 ?
                dataNums.filter(function(n) { return !subNums.some(function(s) { return s.equals(n); }); }) :
                dataNums;
            if (addNumbers.length >= 2) {
                result = addNumbers.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
                steps.push('Suma: ' + addNumbers.join(' + ') + ' = ' + result);
                for (var si2 = 0; si2 < subNums.length; si2++) {
                    var prev2 = result;
                    result = result.minus(subNums[si2]);
                    steps.push('Resta: ' + prev2 + ' - ' + subNums[si2] + ' = ' + result);
                }
                result = QuizMathValidator._applyPercentage(text, result, steps);
                return { value: result, steps: steps };
            }
        }

        return null;
    }

    // Shared Helpers

    static _parseDecimal(str) {
        if (!str) return null;
        try {
            var s = String(str).replace(/,/g, '');
            // Handle sentence-ending periods captured by greedy [\d,.]+ regexes:
            // e.g. "$2,222,222.2222." → after comma removal "2222222.2222." → two dots.
            // Truncate at second dot to keep only the valid decimal portion.
            var dotIdx = s.indexOf('.');
            if (dotIdx >= 0) {
                var secondDot = s.indexOf('.', dotIdx + 1);
                if (secondDot >= 0) s = s.substring(0, secondDot);
            }
            // Strip any remaining trailing dots (standalone sentence terminators)
            s = s.replace(/\.+$/, '');
            if (!s) return null;
            var d = new Decimal(s);
            return d.isFinite() ? d : null;
        } catch (e) { return null; }
    }

    static _applyDecimals(value, text) {
        var match = text.match(/redonde[ao].*?(\d+)\s*decimal/i) || text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i) || text.match(/(?:con|a)\s+(\d+)\s+decimal/i);
        if (match) return value.toDecimalPlaces(parseInt(match[1]));
        if (/redonde[ao]\s+a(?:l)?\s+entero/i.test(text)) return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
        return value;
    }

    static _extractPercentages(text) {
        var pctRe = /([\d,.]+)\s*%/g;
        var result = [],
            m;
        while ((m = pctRe.exec(text)) !== null) {
            var d = QuizMathValidator._parseDecimal(m[1]);
            if (d) result.push(d);
        }
        return result;
    }

    static _extractSubtractionNumbers(text) {
        var results = [];
        var patterns = [
            /(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?)\s+(?:(?:un|una|el|la|los|las|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi,
            /(?:menos|descontando|deduciendo)\s+\$?\s*([\d,]+\.?\d*)/gi,
        ];
        for (var pi = 0; pi < patterns.length; pi++) {
            var m;
            while ((m = patterns[pi].exec(text)) !== null) {
                var d = QuizMathValidator._parseDecimal(m[1]);
                if (d && d.gt(0) && !results.some(function(r) { return r.equals(d); })) results.push(d);
            }
        }
        return results;
    }

    static _extractDataNumbers(text) {
        var dataNumbers = [],
            m;
        var labeledPat = /(?:[a-zA-Z\xe1\xe9\xed\xf3\xfa\xf1\xc1\xc9\xcd\xd3\xda\xd1][a-zA-Z\xe1\xe9\xed\xf3\xfa\xf1\xc1\xc9\xcd\xd3\xda\xd1\s]*[:=]\s*\$?)([\d,]+\.?\d*)/gi;
        while ((m = labeledPat.exec(text)) !== null) { var d = QuizMathValidator._parseDecimal(m[1]); if (d && d.gte(10)) dataNumbers.push(d); }
        if (dataNumbers.length < 2) { dataNumbers.length = 0; var currencyPat = /\$\s?([\d,]+\.?\d*)/gi; while ((m = currencyPat.exec(text)) !== null) { var d2 = QuizMathValidator._parseDecimal(m[1]); if (d2 && d2.gte(1)) dataNumbers.push(d2); } }
        if (dataNumbers.length < 2) { dataNumbers.length = 0; var dePat = /(?:de|por|con|=)\s*\$?\s*([\d,]+\.?\d*)/gi; while ((m = dePat.exec(text)) !== null) { var d3 = QuizMathValidator._parseDecimal(m[1]); if (d3 && d3.gte(10)) dataNumbers.push(d3); } }
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            var stripped = text.replace(/[$\u20ac\xa5\xa3\u20a1\u20bf]\s*/g, '');
            var allNums = stripped.match(/\d[\d,]*\.?\d*/g) || [];
            var pctSet = new Set(QuizMathValidator._extractPercentages(text).map(function(dd) { return dd.toString(); }));
            for (var ai = 0; ai < allNums.length; ai++) {
                var d4 = QuizMathValidator._parseDecimal(allNums[ai]);
                if (!d4 || d4.lt(10)) continue;
                if (pctSet.has(d4.toString())) continue;
                var nv = d4.toNumber();
                if (nv >= 1900 && nv <= 2100 && d4.isInteger()) continue;
                dataNumbers.push(d4);
            }
        }
        return dataNumbers;
    }

    static _applyRate(text, result, steps) {
        var ratePatterns = [
            /costo\s+(?:de\s+(?:procesamiento|producci\xf3n|env\xedo|operaci\xf3n|mantenimiento))?\s*(?:de|es|por|=)?\s*\$?([\d,.]+)/i,
            /precio\s+(?:de|por|unitario|cada)?\s*\$?([\d,.]+)/i,
            /cada\s+\w+\s+(?:tiene\s+)?(?:un\s+)?(?:costo|precio|valor)\s+(?:de\s*)?\$?([\d,.]+)/i,
            /(?:multiplic[a\xe1]r?|\xd7)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /\$\s*([\d,.]+)\s*(?:por|\/)\s*(?:cada|unidad|GB|kg|litro|km|hora)/i,
        ];
        for (var ri = 0; ri < ratePatterns.length; ri++) {
            var rm = text.match(ratePatterns[ri]);
            if (rm) {
                var rate = QuizMathValidator._parseDecimal(rm[1]);
                if (rate && rate.gt(0) && rate.lt(result)) {
                    var prev = result;
                    result = result.times(rate);
                    steps.push('Multiplicacion: ' + prev + ' x ' + rate + ' = ' + result);
                    break;
                }
            }
        }
        return result;
    }

    static _applyPercentage(text, result, steps) {
        var pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA|ISR|inter[e\xe9]s)(?:\s+\w+){0,3}?\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (!pctMatch) return result;
        var pct = QuizMathValidator._parseDecimal(pctMatch[1]);
        if (!pct || pct.lte(0) || pct.gt(200)) return result;
        var prev = result;
        // Determine if the tax/percentage is a deduction
        var isDeduction = /descuento|rebaja/i.test(pctMatch[0]);
        if (!isDeduction) {
            isDeduction = /corporativ|sobre\s+(?:la\s+)?renta|retenci[o\xf3]n|ISR/i.test(pctMatch[0]) ||
                          /despu[e\xe9]s\s+de\s+impuestos?|neto\b/i.test(text);
        }
        if (isDeduction) {
            var f = new Decimal(1).minus(pct.div(100));
            result = result.times(f);
            steps.push('Deducci\xf3n ' + pct + '%: ' + prev + ' \xd7 ' + f + ' = ' + result);
        } else {
            var f2 = new Decimal(1).plus(pct.div(100));
            result = result.times(f2);
            steps.push('+ ' + pct + '%: ' + prev + ' \xd7 ' + f2 + ' = ' + result);
        }
        return result;
    }

    static _applyPostSubtraction(text, result, excludeNumbers, steps) {
        var subMatch = text.match(/(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?)\s+(?:(?:un|una|el|la|los|las|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/i);
        if (!subMatch) return result;
        var subVal = QuizMathValidator._parseDecimal(subMatch[1]);
        if (!subVal || subVal.lte(0)) return result;
        if (excludeNumbers.some(function(n) { return (n instanceof Decimal ? n.equals(subVal) : new Decimal(n).equals(subVal)); })) return result;
        var prev = result;
        result = result.minus(subVal);
        steps.push('Sustraccion: ' + prev + ' - ' + subVal + ' = ' + result);
        return result;
    }

    static _applyPostAddition(text, result, excludeNumbers, steps) {
        var addMatch = text.match(/(?:se\s+)?(?:agrega[rn]?|a\xf1ad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (!addMatch) return result;
        var addVal = QuizMathValidator._parseDecimal(addMatch[1]);
        if (!addVal || addVal.lte(0)) return result;
        if (excludeNumbers.some(function(n) { return (n instanceof Decimal ? n.equals(addVal) : new Decimal(n).equals(addVal)); })) return result;
        var prev = result;
        result = result.plus(addVal);
        steps.push('Adicion: ' + prev + ' + ' + addVal + ' = ' + result);
        return result;
    }

    static _detectFollowUpOperations(text) {
            if (!text) return [];
            var operations = [];

            // Special: "se le resta la suma de los primeros N números"
            // This means: from the total sum, subtract the sum of the first N addends
            // Supports both digit ("4") and Spanish word ("cuatro") for N
            var restaSumaRe = /resta[rn]?\s+(?:la\s+)?suma\s+de\s+los\s+primeros?\s+(\d+|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+n[u\xfa]meros?/i;
            var restaSumaM = restaSumaRe.exec(text);
            if (restaSumaM) {
                var _wtn = {
                    'un': 1,
                    'uno': 1,
                    'una': 1,
                    'dos': 2,
                    'tres': 3,
                    'cuatro': 4,
                    'cinco': 5,
                    'seis': 6,
                    'siete': 7,
                    'ocho': 8,
                    'nueve': 9,
                    'diez': 10,
                    'once': 11,
                    'doce': 12
                };
                var _cap = restaSumaM[1].toLowerCase();
                var nRestar = _wtn[_cap] || parseInt(_cap, 10);
                (function(count, pos) {
                    operations.push({
                        apply: function(total, allNumbers) {
                            if (!allNumbers || allNumbers.length < count) return total;
                            var partSum = new Decimal(0);
                            for (var pi = 0; pi < count; pi++) partSum = partSum.plus(allNumbers[pi]);
                            return total.minus(partSum);
                        },
                        describe: function(p, r) { return 'Resta suma de primeros ' + count + ': ' + p + ' → ' + r; },
                        position: pos,
                        needsAllNumbers: true,
                    });
                })(nRestar, restaSumaM.index);
            }

            var addRe = /(?:y\s+)?(?:se\s+(?:le\s+)?)?(?:agrega[rn]?|a\xf1ad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?|m\xe1s)\s+(?:(?:un|una|el|la|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi;
            var m;
            while ((m = addRe.exec(text)) !== null) {
                var v = QuizMathValidator._parseDecimal(m[1]);
                // Skip if the captured number is part of a percentage (e.g., "10%")
                var afterAdd = text.substring(m.index + m[0].length);
                if (v && v.gt(0) && !/^\s*%/.test(afterAdd)) {
                    (function(val, pos) { operations.push({ apply: function(x) { return x.plus(val); }, describe: function(p, r) { return 'Adicion: ' + p + ' + ' + val + ' = ' + r; }, position: pos }); })(v, m.index);
                }
            }
            var subRe = /(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?|menos)\s+(?:(?:un|una|el|la|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi;
            while ((m = subRe.exec(text)) !== null) {
                var v2 = QuizMathValidator._parseDecimal(m[1]);
                if (v2 && v2.gt(0)) {
                    (function(val, pos) { operations.push({ apply: function(x) { return x.minus(val); }, describe: function(p, r) { return 'Sustraccion: ' + p + ' - ' + val + ' = ' + r; }, position: pos }); })(v2, m.index);
                }
            }
            var multRe = /(?:multiplic[a\xe1]r?\s+por|\xd7)\s*\$?([\d,.]+)/gi;
            var m3 = multRe.exec(text);
            if (m3) {
                var f = QuizMathValidator._parseDecimal(m3[1]);
                if (f && f.gt(0)) {
                    (function(val, pos) { operations.push({ apply: function(x) { return x.times(val); }, describe: function(p, r) { return 'Multiplicacion: ' + p + ' x ' + val + ' = ' + r; }, position: pos }); })(f, m3.index);
                }
            }
            var pctMatch = /(?:impuesto|descuento|incremento|aumento|IVA|ISR|inter[e\xe9]s)(?:\s+\w+){0,3}?\s+(?:del?)?\s*([\d,.]+)\s*%/i.exec(text);
            if (pctMatch) {
                var pct = QuizMathValidator._parseDecimal(pctMatch[1]);
                if (pct && pct.gt(0)) {
                    var isDisc = /descuento|rebaja/i.test(pctMatch[0]) ||
                                 /corporativ|sobre\s+(?:la\s+)?renta|retenci[o\xf3]n|ISR/i.test(pctMatch[0]) ||
                                 /despu[e\xe9]s\s+de\s+impuestos?|neto\b/i.test(text);
                    var pf = isDisc ? new Decimal(1).minus(pct.div(100)) : new Decimal(1).plus(pct.div(100));
                    var lbl = isDisc ? 'Deducci\xf3n' : 'Incremento';
                    (function(factor, label, p, pos) { operations.push({ apply: function(x) { return x.times(factor); }, describe: function(prev, r) { return label + ' ' + p + '%: ' + prev + ' x ' + factor + ' = ' + r; }, position: pos }); })(pf, lbl, pct, pctMatch.index);
                }
            }
            operations.sort(function(a, b) { return a.position - b.position; });
            return operations;
        }
        // Explanation based validation

    /**
     * DEPRECATED: No longer used. LLM explanations are NEVER trusted as
     * a source of truth. This was the root cause of fabricated answers.
     * Kept as no-op for backward compatibility.
     * @deprecated
     */
    static _tryFromExplanation(_text) {
        return null;
    }

    static _findClosestOption(options, value) {
        if (!options || !options.length || !value) return null;
        var bestIdx = -1,
            bestDiff = null;
        for (var fi = 0; fi < options.length; fi++) {
            var optStr = String(options[fi]);
            var opt = null;

            // Strip letter prefix (e.g., "A) ", "B. ") before parsing
            var stripped = optStr.trim().replace(/^[A-Za-z]\)\s*/, '').replace(/^[A-Za-z]\.\s*/, '').trim();

            // Try parsing as fraction first (e.g., "89/72")
            var parsedFrac = MathEngine.parseFraction(stripped);
            if (parsedFrac) {
                opt = MathEngine.fractionToDecimal(parsedFrac);
            }

            // Fall back to decimal parsing
            if (!opt) {
                var cleaned = optStr.replace(/[^\d.,-]/g, '');
                opt = QuizMathValidator._parseDecimal(cleaned);
            }

            if (!opt) continue;
            var diff = value.minus(opt).abs();
            if (bestDiff === null || diff.lt(bestDiff)) {
                bestDiff = diff;
                bestIdx = fi;
            }
        }
        if (bestIdx === -1) return null; // no option could be parsed as a number

        var optStr2 = String(options[bestIdx]);
        var bestOpt = null;
        var stripped2 = optStr2.trim().replace(/^[A-Za-z]\)\s*/, '').replace(/^[A-Za-z]\.\s*/, '').trim();
        var parsedFrac2 = MathEngine.parseFraction(stripped2);
        if (parsedFrac2) {
            bestOpt = MathEngine.fractionToDecimal(parsedFrac2);
        }
        if (!bestOpt) {
            bestOpt = QuizMathValidator._parseDecimal(optStr2.replace(/[^\d.,-]/g, ''));
        }
        if (!bestOpt) return null;
        var relErr = value.isZero() ? bestDiff : bestDiff.div(value.abs());
        // Dynamic tolerance: tighter for large numbers, more lenient for small
        var dynAbsTol = value.abs().gt(1000) ? new Decimal('0.01') : OPTION_ABS_TOLERANCE;
        // within = true means the closest option is within tolerance
        var within = !(relErr.gt(OPTION_REL_TOLERANCE) && bestDiff.gt(dynAbsTol));
        return { index: bestIdx, value: bestOpt, within: within };
    }

    // Ordering Helpers

    /**
     * Validates ordering question semantics using OrderingQuestionValidator.
     * @param {string} question - Question text
     * @param {string[]} items - Items in claimed correct order
     * @returns {{ valid: boolean, items?: string[], reason?: string, corrections?: string[] }}
     */
    static validateOrdering(question, items) {
        return OrderingQuestionValidator.validateQuestion(question, items);
    }

    static fixOrderingQuestion(items, rawCorrectOrder) {
        if (!items || !items.length || items.length < 2) return null;

        var correctSequence;

        // Try numeric sorting first
        var numeric = [];
        var canSortNumeric = true;
        for (var oi = 0; oi < items.length; oi++) {
            var d = QuizMathValidator._parseDecimal(String(items[oi]).replace(/[^\d.,-]/g, ''));
            if (!d) { canSortNumeric = false; break; }
            numeric.push({ original: items[oi], value: d, origIdx: oi });
        }

        if (canSortNumeric) {
            var isDesc = false;
            if (typeof rawCorrectOrder === 'string') {
                isDesc = /descend|mayor\s*a\s*menor|de\s*mayor/i.test(rawCorrectOrder);
            } else if (Array.isArray(rawCorrectOrder) && rawCorrectOrder.length >= 2) {
                var first = QuizMathValidator._parseDecimal(String(rawCorrectOrder[0]).replace(/[^\d.,-]/g, ''));
                var last = QuizMathValidator._parseDecimal(String(rawCorrectOrder[rawCorrectOrder.length - 1]).replace(/[^\d.,-]/g, ''));
                if (first && last) isDesc = first.gt(last);
            }
            var sorted = numeric.slice().sort(function(a, b) { return isDesc ? b.value.cmp(a.value) : a.value.cmp(b.value); });
            correctSequence = sorted.map(function(s) { return s.original; });
        } else if (Array.isArray(rawCorrectOrder) && rawCorrectOrder.length === items.length) {
            // Non-numeric: use LLM-provided correctOrder indices
            var validIndices = rawCorrectOrder.every(function(i) { return Number.isInteger(i) && i >= 0 && i < items.length; });
            correctSequence = validIndices ?
                rawCorrectOrder.map(function(i) { return items[i]; }) :
                items.slice();
        } else {
            correctSequence = items.slice();
        }

        // Fisher-Yates shuffle for display order
        var shuffled = items.slice();
        for (var si = shuffled.length - 1; si > 0; si--) {
            var sj = Math.floor(Math.random() * (si + 1));
            var tmp = shuffled[si];
            shuffled[si] = shuffled[sj];
            shuffled[sj] = tmp;
        }
        // Re-shuffle if identical to correctSequence (avoid presenting already-ordered items)
        var attempts = 5;
        while (attempts-- > 0 && shuffled.every(function(itm, idx) { return itm === correctSequence[idx]; })) {
            for (var si2 = shuffled.length - 1; si2 > 0; si2--) {
                var sj2 = Math.floor(Math.random() * (si2 + 1));
                var tmp2 = shuffled[si2];
                shuffled[si2] = shuffled[sj2];
                shuffled[sj2] = tmp2;
            }
        }

        // correctOrder[i] = index in shuffled where correctSequence[i] is located
        var correctOrder = correctSequence.map(function(item) { return shuffled.indexOf(item); });

        return { items: shuffled, correctOrder: correctOrder, correctSequence: correctSequence };
    }

    static buildOrderingExplanation(correctSequence, llmExplanation) {
        if (!correctSequence || !correctSequence.length) return llmExplanation || '';

        // Determine if this is a NUMERIC SORTING question or a PROCEDURAL STEPS question
        var allNumeric = correctSequence.every(function(item) {
            var cleaned = String(item).replace(/[^\d.,-]/g, '');
            return cleaned.length > 0 && QuizMathValidator._parseDecimal(cleaned) !== null;
        });

        if (allNumeric) {
            // Numeric sorting: indicate direction (ascending / descending)
            var f = QuizMathValidator._parseDecimal(String(correctSequence[0]).replace(/[^\d.,-]/g, ''));
            var l = QuizMathValidator._parseDecimal(String(correctSequence[correctSequence.length - 1]).replace(/[^\d.,-]/g, ''));
            var isDesc = f && l ? f.gt(l) : false;
            var direction = isDesc ? 'descendente (mayor a menor)' : 'ascendente (menor a mayor)';
            var numExplanation = 'El orden correcto ' + direction + ' es: ' + correctSequence.join(' → ');
            return llmExplanation ?
                (llmExplanation + '\n' + numExplanation) :
                numExplanation;
        }

        // Procedural steps: list them numbered — ONLY use corrected sequence,
        // NOT the LLM explanation (which may contain contradictory information).
        var stepsText = correctSequence.map(function(s, i) { return (i + 1) + '. ' + s; }).join('\n');
        var procExplanation = 'El orden correcto de los pasos es:\n' + stepsText;

        return procExplanation;
    }

    static _stripOrderingClaims(text) {
        if (!text) return text;
        return text
            // Eliminar claims de orden que pueden ser incorrectos
            .replace(/(?:el\s+)?orden\s+(?:correcto|es|ser\xeda)[^.]*\./gi, '')
            .replace(/(?:de\s+)?(?:mayor|menor)\s+a\s+(?:mayor|menor)[^.]*\./gi, '')
            // Eliminar numeraciones del LLM que pueden contradecir el orden real
            .replace(/\d+\s*(?:pasos?|etapas?):\s*(?:\d+\))/gi, '')
            // Eliminar enumeraciones tipo "1) Alineación... 2) Suma..."
            .replace(/\d+\)\s+[A-ZÁÉÍÓÚ][^.]*\.\s*/gi, '')
            // Eliminar frases con datos numéricos contradictorios sobre dígitos
            .replace(/(?:el\s+)?(?:cuarto|quinto|sexto|s[eé]ptimo)\s+decimal\s+(?:es|ser[ií]a)\s+\d+[^.]*\./gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 2.5: Derivative / Extrema Problems
    // "f(x) = x³ - 12x² + 45x - 10, ¿cuál es el valor de x donde ocurre
    //  el mínimo local?" → f'(x) = 0 → x = 5
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryDerivativeExtremaProblem(text) {
        if (!DERIVATIVE_PATTERNS.some(function(re) { return re.test(text); })) return null;

        // Must have f(x) = polynomial
        // Stop at comma or period NOT part of a decimal number
        var fxMatch = text.match(/f\s*\(\s*x\s*\)\s*=\s*((?:[^.,]|\.(?=\d))+)/i);
        if (!fxMatch) return null;

        var polyText = fxMatch[1].trim();
        var coeffs = MathEngine.parsePolynomialFromText(polyText);
        if (!coeffs) return null;

        var maxPower = Math.max.apply(null, Object.keys(coeffs).map(Number));
        if (maxPower < 2 || maxPower > 6) return null;

        var extrema = MathEngine.findPolynomialExtrema(coeffs);
        if (!extrema) return null;

        var lower = text.toLowerCase();
        var wantsMin = /m[i\xed]nimo|m[i\xed]n(?:imo)?\s+local/i.test(lower);
        var wantsMax = /m[a\xe1]ximo|m[a\xe1]x(?:imo)?\s+local/i.test(lower) && !wantsMin;
        var wantsX = /valor\s+de\s+x|cu[a\xe1]l\s+es\s+(?:el\s+)?(?:valor|x)/i.test(lower);

        var steps = extrema.steps.slice();
        var result = null;

        if (wantsMin && extrema.minima.length > 0) {
            // Question asks for integer → find the integer minimum
            var intMin = extrema.minima.filter(function(p) { return p.x.isInteger(); });
            var target = intMin.length > 0 ? intMin[0] : extrema.minima[0];
            result = wantsX || /valor\s+de\s+x|x\s+\(/i.test(lower) ? target.x : target.y;
            steps.push('Respuesta (x del mínimo): ' + target.x);
        } else if (wantsMax && extrema.maxima.length > 0) {
            var intMax = extrema.maxima.filter(function(p) { return p.x.isInteger(); });
            var target2 = intMax.length > 0 ? intMax[0] : extrema.maxima[0];
            result = wantsX || /valor\s+de\s+x|x\s+\(/i.test(lower) ? target2.x : target2.y;
            steps.push('Respuesta (x del máximo): ' + target2.x);
        } else if (extrema.minima.length > 0 || extrema.maxima.length > 0) {
            // Generic "extremo local" — return first found
            var all = extrema.minima.concat(extrema.maxima);
            if (all.length > 0) {
                result = all[0].x;
                steps.push('Punto crítico: x = ' + result);
            }
        }

        if (result === null) return null;
        return { value: result, steps: steps };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Strategy 2.6: Scientific Notation Sum / Conversion
    // "A = 5.678912e8, B = 3.456789e7, C = 1.234567e6. Suma y expresa..."
    // ═══════════════════════════════════════════════════════════════════════════

    static _tryScientificNotationSum(text) {
        if (!/notaci[o\xf3]n\s+cient[i\xed]fica|[eE]\d+|10\s*\^/i.test(text)) return null;

        var numbers = MathEngine.parseScientificNumbers(text);
        if (numbers.length < 2) return null;

        var steps = [];
        var sum = new Decimal(0);
        for (var i = 0; i < numbers.length; i++) {
            sum = sum.plus(numbers[i]);
            steps.push('Número ' + (i + 1) + ': ' + numbers[i].toExponential(6));
        }
        steps.push('Suma: ' + sum.toExponential(6));

        // Check if the question asks for a coefficient (mantissa)
        var wantsCoefficient = /coeficiente|mantisa/i.test(text);
        var sigFigMatch = text.match(/(\d+)\s*(?:cifras?\s+significativas?|d[i\xed]gitos?\s+significativos?)/i);
        var sigFigs = sigFigMatch ? parseInt(sigFigMatch[1], 10) : null;

        if (wantsCoefficient || sigFigs) {
            var sciNot = MathEngine.toScientificNotation(sum);
            var mantissa = sciNot.mantissa;
            if (sigFigs) {
                mantissa = MathEngine.roundToSignificantFigures(mantissa, sigFigs);
                steps.push('Coeficiente redondeado a ' + sigFigs + ' cifras significativas: ' + mantissa);
            } else {
                steps.push('Coeficiente: ' + mantissa + ' × 10^' + sciNot.exponent);
            }
            return { value: mantissa, steps: steps };
        }

        // Check for rounding
        if (/redonde[ao]\s+.*?entero/i.test(text)) {
            sum = sum.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
            steps.push('Redondeado al entero: ' + sum);
        }

        return { value: sum, steps: steps };
    }

}

export default QuizMathValidator;