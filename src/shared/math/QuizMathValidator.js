import Decimal from 'decimal.js';

Decimal.set({ precision: 64 });

const MATH_SIGNALS = /calcula|suma|total|multiplica|divide|resta|resultado|costo\s+total|precio\s+total|monto\s+total|redondea|\xbfcu\xe1nto|cu\xe1ntos|cu\xe1ntas|promedio|media|porcentaje/i;
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
    /derivada|d\/dx/i,
];

const META_QUESTION_PATTERNS = [
    /d[i\xed]gito\s+(?:de\s+las?\s+)?(?:centenas?|decenas?|unidades?|miles?|millones?)/i,
    /posici[o\xf3]n\s+10[\u2070\xb9\xb2\xb3\u2074\u2075\u2076\u2077\u2078\u2079]+/i,
    /\xbfcu[a\xe1]l\s+es\s+el\s+d[i\xed]gito/i,
    /cifra\s+(?:de|en)\s+(?:la\s+)?posici[o\xf3]n/i,
];

// Tolerance for option matching: 1% relative OR 0.5 absolute
const OPTION_REL_TOLERANCE = new Decimal('0.01');
const OPTION_ABS_TOLERANCE = new Decimal('0.5');
// When a rigorous formula answer is > this factor larger than the max option,
// the question is considered mathematically broken (LLM fabricated options).
const BROKEN_QUESTION_FACTOR = new Decimal('100');

export class QuizMathValidator {

    static verify(q) {
        if (!q) return q;
        var text = q.question;
        if (!text || typeof text !== 'string') return q;
        var lower = text.toLowerCase();

        var isAdvanced = QuizMathValidator._isAdvancedMathProblem(text);
        var hasMathSignals = MATH_SIGNALS.test(lower)
            || HAS_SIGNIFICANT_NUMBERS.test(text.replace(/,/g, ''))
            || isAdvanced;

        if (!hasMathSignals) return q;
        if (META_QUESTION_PATTERNS.some(function(re) { return re.test(text); })) return q;

        try {
            var result = QuizMathValidator.computeExpectedAnswer(text);

            // Only use LLM explanation as a fallback when the problem is NOT advanced formula-based.
            // For geometric series, summations, etc. the LLM explanation may contain a fabricated answer —
            // trusting it blindly would hide the real mathematical error.
            if (!isAdvanced && q.explanation && typeof q.explanation === 'string') {
                var explResult = QuizMathValidator._tryFromExplanation(q.explanation);
                if (explResult) {
                    result = QuizMathValidator._reconcileResults(result, explResult, q);
                }
            }

            if (!result) return q;

            // Sanity check: if the formula produced an astronomically large answer but the question
            // options are small, the question itself is mathematically broken. Reject it so it doesn't
            // reach students.
            if (result.fromFormula && q.type === 'multiple_choice' && Array.isArray(q.options)) {
                if (QuizMathValidator._isBrokenQuestion(result.value, q.options)) {
                    console.warn('[MathVerify] BROKEN QUESTION: formula gives ' + result.value.toExponential(4) +
                        ' but all options are orders of magnitude smaller. Rejecting.');
                    return null;
                }
            }

            var finalAnswer = QuizMathValidator._applyDecimals(result.value, text);

            if (q.type === 'fill_in_blank') {
                return QuizMathValidator._verifyFillInBlank(q, finalAnswer, result.steps);
            }
            if (q.type === 'multiple_choice') {
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
        var arithmetic = QuizMathValidator._tryExplicitArithmetic(text);
        if (arithmetic) return arithmetic;
        var formula = QuizMathValidator._tryFormulaEvaluation(text);
        if (formula) return formula;
        if (QuizMathValidator._isAdvancedMathProblem(text)) return null;
        return QuizMathValidator._tryWordProblem(text) || QuizMathValidator._trySumFallback(text);
    }

    static _isAdvancedMathProblem(text) {
        return ADVANCED_FORMULA_PATTERNS.some(function(re) { return re.test(text); });
    }

    static _reconcileResults(computed, explanation, q) {
        if (!computed) return explanation;
        if (!explanation) return computed;
        if (computed.value.equals(explanation.value)) return computed;
        if (computed.fromFormula) return computed;
        if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
            var cMatch = QuizMathValidator._findClosestOption(q.options, computed.value);
            var eMatch = QuizMathValidator._findClosestOption(q.options, explanation.value);
            // Null-safe: _findClosestOption can return null when no options parse as numbers
            var eWithin = eMatch !== null && eMatch.within;
            var cWithin = cMatch !== null && cMatch.within;
            if (eWithin && !cWithin) return explanation;
        } else if (q.type === 'fill_in_blank') {
            return explanation;
        }
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
        var match = QuizMathValidator._findClosestOption(q.options, finalAnswer);
        // match is null when no option could be parsed as a number — skip validation
        if (match === null) return q;
        if (match.within) {
            if (match.index !== q.correctIndex) {
                console.warn('[MathVerify] CORRECTED MC: index ' + q.correctIndex + ' -> ' + match.index);
                q.correctIndex = match.index;
                q.explanation = steps.join('. ') + '. Resultado final: ' + finalAnswer + '.';
            }
            return q;
        }
        console.warn('[MathVerify] REJECTED: No option matches computed=' + finalAnswer);
        return null;
    }

    // Strategy 1: Explicit Arithmetic

    static _tryExplicitArithmetic(text) {
        var cleaned = text.replace(/[$\u20ac\xa5\xa3\u20a1\u20bf]\s*/g, '');
        cleaned = cleaned.replace(/(\d[\d,]*\.?\d*)\s*\(\s*(\d[\d,]*\.?\d*)\s*\)/g, '$1 \xd7 $2');
        var numberPat = '\\d[\\d,]*\\.?\\d*';
        var opPat = '[+\\-\\xd7*\\xf7/]';
        var exprRegex = new RegExp(
            '(' + numberPat + ')\\s*(' + opPat + ')\\s*(' + numberPat + '(?:\\s*' + opPat + '\\s*' + numberPat + ')*)', 'g'
        );
        var match = exprRegex.exec(cleaned);
        if (!match) return null;
        var tokens = match[0].split(/\s*([+\-\xd7*\xf7/])\s*/).filter(function(t) { return t.trim(); });
        var result = QuizMathValidator._parseDecimal(tokens[0]);
        if (!result) return null;
        var steps = [];
        for (var i = 1; i < tokens.length; i += 2) {
            var op = tokens[i];
            var num = QuizMathValidator._parseDecimal(tokens[i + 1]);
            if (!num) return null;
            var prev = result;
            if (op === '+') result = result.plus(num);
            else if (op === '-') result = result.minus(num);
            else if (op === '\xd7' || op === '*') result = result.times(num);
            else if (op === '\xf7' || op === '/') {
                if (num.isZero()) return null;
                result = result.div(num);
            }
            else return null;
            steps.push(prev + ' ' + op + ' ' + num + ' = ' + result);
        }
        var afterExpr = cleaned.substring(cleaned.indexOf(match[0]) + match[0].length);
        var followUps = QuizMathValidator._detectFollowUpOperations(afterExpr);
        for (var fi = 0; fi < followUps.length; fi++) {
            var prevF = result;
            result = followUps[fi].apply(result);
            steps.push(followUps[fi].describe(prevF, result));
        }
        return { value: result, steps: steps };
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
            if (vals[0].isZero()) continue;
            var r = vals[1].div(vals[0]);
            if (r.eq(1)) continue; // not geometric (would be arithmetic)
            // Verify the ratio is consistent across all extracted values
            var consistent = true;
            for (var vi = 2; vi < vals.length; vi++) {
                if (!vals[vi].div(vals[vi - 1]).toFixed(8) === r.toFixed(8)) { consistent = false; break; }
            }
            if (!consistent) continue;
            // Ratio should be a simple integer or simple fraction to avoid false positives
            var rNum = parseFloat(r.toFixed(6));
            if (!Number.isFinite(rNum) || rNum <= 0) continue;
            // Accept only if ratio is integer or simple fraction (e.g. 1.5, 2, 3, 0.5)
            var isSimpleRatio = Math.abs(rNum - Math.round(rNum)) < 0.001 ||
                Math.abs(rNum * 2 - Math.round(rNum * 2)) < 0.001 ||
                Math.abs(rNum * 3 - Math.round(rNum * 3)) < 0.001;
            if (!isSimpleRatio) continue;
            // All checks passed: compute the sum S_n = a1*(r^n - 1)/(r - 1)
            var a1 = vals[0];
            var rPowN = r.pow(n);
            var seriesResult = a1.times(rPowN.minus(1)).div(r.minus(1));
            console.log('[MathVerify] Implicit geometric series detected: a1=' + a1 + ', r=' + r.toFixed(4) + ', n=' + n + ' → S_n=' + seriesResult.toExponential(4));
            return {
                value: seriesResult,
                steps: [
                    'Secuencia geométrica detectada: a1=' + a1 + ', r=' + r.toFixed(4) + ', n=' + n,
                    'S_n = a1·(r^n − 1)/(r − 1) = ' + a1 + '·(' + r.toFixed(4) + '^' + n + ' − 1)/(' + r.toFixed(4) + ' − 1) = ' + seriesResult,
                ],
                fromFormula: true,
            };
        }
        return null;
    }

    static _tryCombinedFormula(text) {
        var summation = QuizMathValidator._tryPolynomialSummation(text);
        var geo = QuizMathValidator._tryGeometricSeriesFormula(text);
        if (summation && geo) {
            var total = summation.value.plus(geo.value);
            return {
                value: total,
                steps: summation.steps.concat(geo.steps).concat(['Total combinado: ' + summation.value + ' + ' + geo.value + ' = ' + total]),
                fromFormula: true,
            };
        }
        var arith = QuizMathValidator._tryArithmeticSeriesFormula(text);
        if (summation && arith) {
            var total2 = summation.value.plus(arith.value);
            return {
                value: total2,
                steps: summation.steps.concat(arith.steps).concat(['Total combinado: ' + summation.value + ' + ' + arith.value + ' = ' + total2]),
                fromFormula: true,
            };
        }
        return null;
    }

    static _tryPolynomialSummation(text) {
        var sigmaPatterns = [
            /[\u03A3\u2211]\s*\(?(?:de\s+)?i\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(([^)]+)\)/i,
            /sumatoria\s*(?::\s*)?[\u03A3\u2211]?\s*\(?(?:de\s+)?i\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(([^)]+)\)/i,
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
        var rPowN = r.pow(n);
        var seriesResult = a1.times(rPowN.minus(1)).div(r.minus(1));
        return {
            value: seriesResult,
            steps: ['Serie geometrica: a1=' + a1 + ', r=' + r + ', n=' + n, 'S_n = ' + a1 + '(' + r + '^' + n + ' - 1)/(' + r + ' - 1) = ' + seriesResult],
            fromFormula: true,
        };
    }

    static _tryArithmeticSeriesFormula(text) {
        if (!/serie\s+aritm[e\xe9]trica|progresi[o\xf3]n\s+aritm[e\xe9]trica/i.test(text)) return null;
        var a1, d, n;
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
        var nDec = new Decimal(n);
        var seriesResult = nDec.div(2).times(a1.times(2).plus(d.times(nDec.minus(1))));
        return {
            value: seriesResult,
            steps: ['Serie aritmetica: a1=' + a1 + ', d=' + d + ', n=' + n, 'S_n = ' + seriesResult],
            fromFormula: true,
        };
    }
    // Strategy 3: Word Problem (GUARDED)

    static _tryWordProblem(text) {
        var lower = text.toLowerCase();
        if (!/total|suma|calcula|acumulad|promedio|media|\xbfcu\xe1nto|cu\xe1ntos|monto|resultado/i.test(lower)) return null;
        var dataNumbers = QuizMathValidator._extractDataNumbers(text);
        if (dataNumbers.length < 2) return null;
        var subtractionNums = QuizMathValidator._extractSubtractionNumbers(text);
        var additionNumbers = subtractionNums.length > 0
            ? dataNumbers.filter(function(num) { return !subtractionNums.some(function(s) { return s.equals(num); }); })
            : dataNumbers;
        var steps = [];
        var result;
        if (/promedio|media\b/i.test(lower)) {
            var nums = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;
            var sum = nums.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
            result = sum.div(nums.length);
            steps.push('Suma: ' + nums.join(' + ') + ' = ' + sum);
            steps.push('Promedio: ' + sum + ' / ' + nums.length + ' = ' + result);
        } else {
            var nums2 = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;
            result = nums2.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
            steps.push('Suma: ' + nums2.join(' + ') + ' = ' + result);
        }
        for (var si = 0; si < subtractionNums.length; si++) {
            var prev = result;
            result = result.minus(subtractionNums[si]);
            steps.push('Resta: ' + prev + ' - ' + subtractionNums[si] + ' = ' + result);
        }
        result = QuizMathValidator._applyRate(text, result, steps);
        result = QuizMathValidator._applyPercentage(text, result, steps);
        result = QuizMathValidator._applyPostAddition(text, result, dataNumbers, steps);
        result = QuizMathValidator._applyPostSubtraction(text, result, dataNumbers.concat(subtractionNums), steps);
        return steps.length > 0 ? { value: result, steps: steps } : null;
    }

    // Strategy 4: Sum Fallback (GUARDED)

    static _trySumFallback(text) {
        var lower = text.toLowerCase();
        if (!/(?:total|suma|calcula|resultado|\xbfcu\xe1nto|cu\xe1ntos|monto|costo|precio|valor)/i.test(lower)) return null;
        var cleaned = text.replace(/[$\u20ac\xa5\xa3\u20a1\u20bf]\s*/g, '');
        var pctValues = QuizMathValidator._extractPercentages(text);
        var numRe = /\d[\d,]*\.?\d*/g;
        var nm, candidates = [];
        while ((nm = numRe.exec(cleaned)) !== null) {
            var val = QuizMathValidator._parseDecimal(nm[0]);
            if (!val) continue;
            if (pctValues.some(function(p) { return p.equals(val); })) continue;
            if (val.lte(5)) continue;
            var nVal = val.toNumber();
            if (nVal >= 1900 && nVal <= 2100 && val.isInteger()) continue;
            candidates.push(val);
        }
        if (candidates.length < 2) return null;
        var sorted = candidates.slice().sort(function(a, b) { return a.cmp(b); });
        var largest = sorted[sorted.length - 1];
        var dataNumbers = sorted.filter(function(num) { return num.gte(largest.times('0.001')) && num.gte(10); });
        if (dataNumbers.length < 2) return null;
        var subtractionNums = QuizMathValidator._extractSubtractionNumbers(text);
        var additionNumbers = subtractionNums.length > 0
            ? dataNumbers.filter(function(num) { return !subtractionNums.some(function(s) { return s.equals(num); }); })
            : dataNumbers;
        var steps = [];
        var result;
        if (/promedio|media\b/i.test(lower)) {
            var nums = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;
            var sum = nums.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
            result = sum.div(nums.length);
            steps.push('Suma: ' + nums.join(' + ') + ' = ' + sum);
            steps.push('Promedio: ' + sum + ' / ' + nums.length + ' = ' + result);
        } else {
            var nums2 = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;
            result = nums2.reduce(function(a, b) { return a.plus(b); }, new Decimal(0));
            steps.push('Suma: ' + nums2.join(' + ') + ' = ' + result);
        }
        for (var si = 0; si < subtractionNums.length; si++) {
            var prev = result;
            result = result.minus(subtractionNums[si]);
            steps.push('Resta: ' + prev + ' - ' + subtractionNums[si] + ' = ' + result);
        }
        if (pctValues.length > 0) {
            var pct = pctValues[0];
            if (pct.gt(0) && pct.lte(200)) {
                var prevP = result;
                if (/descuento/i.test(lower)) {
                    var factor = new Decimal(1).minus(pct.div(100));
                    result = result.times(factor);
                    steps.push('Descuento ' + pct + '%: ' + prevP + ' x ' + factor + ' = ' + result);
                } else if (/impuesto|iva|incremento|aumento|inter\xe9s|recargo/i.test(lower)) {
                    var factor2 = new Decimal(1).plus(pct.div(100));
                    result = result.times(factor2);
                    steps.push('+ ' + pct + '%: ' + prevP + ' x ' + factor2 + ' = ' + result);
                }
            }
        }
        result = QuizMathValidator._applyRate(text, result, steps);
        result = QuizMathValidator._applyPostAddition(text, result, candidates, steps);
        result = QuizMathValidator._applyPostSubtraction(text, result, candidates.concat(subtractionNums), steps);
        return steps.length > 0 ? { value: result, steps: steps } : null;
    }

    // Shared Helpers

    static _parseDecimal(str) {
        if (!str) return null;
        try { var d = new Decimal(String(str).replace(/,/g, '')); return d.isFinite() ? d : null; }
        catch (e) { return null; }
    }

    static _applyDecimals(value, text) {
        var match = text.match(/redonde[ao].*?(\d+)\s*decimal/i) || text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i);
        if (match) return value.toDecimalPlaces(parseInt(match[1]));
        if (/redonde[ao]\s+a\s+entero/i.test(text)) return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
        return value;
    }

    static _extractPercentages(text) {
        var pctRe = /([\d,.]+)\s*%/g;
        var result = [], m;
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
        var dataNumbers = [], m;
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
                    var prev = result; result = result.times(rate);
                    steps.push('Multiplicacion: ' + prev + ' x ' + rate + ' = ' + result);
                    break;
                }
            }
        }
        return result;
    }

    static _applyPercentage(text, result, steps) {
        var pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA|ISR|inter\xe9s)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (!pctMatch) return result;
        var pct = QuizMathValidator._parseDecimal(pctMatch[1]);
        if (!pct || pct.lte(0) || pct.gt(200)) return result;
        var prev = result;
        if (/descuento/i.test(pctMatch[0])) {
            var f = new Decimal(1).minus(pct.div(100)); result = result.times(f);
            steps.push('Descuento ' + pct + '%: ' + prev + ' x ' + f + ' = ' + result);
        } else {
            var f2 = new Decimal(1).plus(pct.div(100)); result = result.times(f2);
            steps.push('+ ' + pct + '%: ' + prev + ' x ' + f2 + ' = ' + result);
        }
        return result;
    }

    static _applyPostSubtraction(text, result, excludeNumbers, steps) {
        var subMatch = text.match(/(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?)\s+(?:(?:un|una|el|la|los|las|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/i);
        if (!subMatch) return result;
        var subVal = QuizMathValidator._parseDecimal(subMatch[1]);
        if (!subVal || subVal.lte(0)) return result;
        if (excludeNumbers.some(function(n) { return (n instanceof Decimal ? n.equals(subVal) : new Decimal(n).equals(subVal)); })) return result;
        var prev = result; result = result.minus(subVal);
        steps.push('Sustraccion: ' + prev + ' - ' + subVal + ' = ' + result);
        return result;
    }

    static _applyPostAddition(text, result, excludeNumbers, steps) {
        var addMatch = text.match(/(?:se\s+)?(?:agrega[rn]?|a\xf1ad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (!addMatch) return result;
        var addVal = QuizMathValidator._parseDecimal(addMatch[1]);
        if (!addVal || addVal.lte(0)) return result;
        if (excludeNumbers.some(function(n) { return (n instanceof Decimal ? n.equals(addVal) : new Decimal(n).equals(addVal)); })) return result;
        var prev = result; result = result.plus(addVal);
        steps.push('Adicion: ' + prev + ' + ' + addVal + ' = ' + result);
        return result;
    }

    static _detectFollowUpOperations(text) {
        if (!text) return [];
        var operations = [];
        var addRe = /(?:y\s+)?(?:se\s+(?:le\s+)?)?(?:agrega[rn]?|a\xf1ad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?|m\xe1s)\s+(?:(?:un|una|el|la|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi;
        var m;
        while ((m = addRe.exec(text)) !== null) {
            var v = QuizMathValidator._parseDecimal(m[1]);
            if (v && v.gt(0)) { (function(val, pos) { operations.push({ apply: function(x) { return x.plus(val); }, describe: function(p, r) { return 'Adicion: ' + p + ' + ' + val + ' = ' + r; }, position: pos }); })(v, m.index); }
        }
        var subRe = /(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?|menos)\s+(?:(?:un|una|el|la|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi;
        while ((m = subRe.exec(text)) !== null) {
            var v2 = QuizMathValidator._parseDecimal(m[1]);
            if (v2 && v2.gt(0)) { (function(val, pos) { operations.push({ apply: function(x) { return x.minus(val); }, describe: function(p, r) { return 'Sustraccion: ' + p + ' - ' + val + ' = ' + r; }, position: pos }); })(v2, m.index); }
        }
        var multRe = /(?:multiplic[a\xe1]r?\s+por|\xd7)\s*\$?([\d,.]+)/gi;
        var m3 = multRe.exec(text);
        if (m3) { var f = QuizMathValidator._parseDecimal(m3[1]); if (f && f.gt(0)) { (function(val, pos) { operations.push({ apply: function(x) { return x.times(val); }, describe: function(p, r) { return 'Multiplicacion: ' + p + ' x ' + val + ' = ' + r; }, position: pos }); })(f, m3.index); } }
        var pctMatch = /(?:impuesto|descuento|incremento|aumento|IVA)\s+(?:del?)?\s*([\d,.]+)\s*%/i.exec(text);
        if (pctMatch) {
            var pct = QuizMathValidator._parseDecimal(pctMatch[1]);
            if (pct && pct.gt(0)) {
                var isDisc = /descuento/i.test(pctMatch[0]);
                var pf = isDisc ? new Decimal(1).minus(pct.div(100)) : new Decimal(1).plus(pct.div(100));
                var lbl = isDisc ? 'Descuento' : 'Incremento';
                (function(factor, label, p, pos) { operations.push({ apply: function(x) { return x.times(factor); }, describe: function(prev, r) { return label + ' ' + p + '%: ' + prev + ' x ' + factor + ' = ' + r; }, position: pos }); })(pf, lbl, pct, pctMatch.index);
            }
        }
        operations.sort(function(a, b) { return a.position - b.position; });
        return operations;
    }
    // Explanation based validation

    static _tryFromExplanation(text) {
        if (!text) return null;
        var patterns = [
            /(?:resultado?|respuesta|total|valor)\s*(?:es|=|:)\s*\$?\s*([\d,]+\.?\d*)/i,
            /=\s*\$?\s*([\d,]+\.?\d*)\s*$/im,
            /(?:obtenemos|da|encontramos|tenemos|queda)\s+\$?\s*([\d,]+\.?\d*)/i,
        ];
        for (var ei = 0; ei < patterns.length; ei++) {
            var m = text.match(patterns[ei]);
            if (m) {
                var val = QuizMathValidator._parseDecimal(m[1]);
                if (val && val.isFinite()) return { value: val, fromExplanation: true };
            }
        }
        return null;
    }

    static _findClosestOption(options, value) {
        if (!options || !options.length || !value) return null;
        var bestIdx = -1, bestDiff = null;
        for (var fi = 0; fi < options.length; fi++) {
            var optStr = String(options[fi]).replace(/[^\d.,-]/g, '');
            var opt = QuizMathValidator._parseDecimal(optStr);
            if (!opt) continue;
            var diff = value.minus(opt).abs();
            if (bestDiff === null || diff.lt(bestDiff)) {
                bestDiff = diff;
                bestIdx = fi;
            }
        }
        if (bestIdx === -1) return null; // no option could be parsed as a number
        var optStr2 = String(options[bestIdx]).replace(/[^\d.,-]/g, '');
        var bestOpt = QuizMathValidator._parseDecimal(optStr2);
        if (!bestOpt) return null;
        var relErr = value.isZero() ? bestDiff : bestDiff.div(value.abs());
        // within = true means the closest option is within tolerance (1% relative AND/OR 0.5 absolute)
        var within = !(relErr.gt(OPTION_REL_TOLERANCE) && bestDiff.gt(OPTION_ABS_TOLERANCE));
        return { index: bestIdx, value: bestOpt, within: within };
    }

    // Ordering Helpers

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
            correctSequence = validIndices
                ? rawCorrectOrder.map(function(i) { return items[i]; })
                : items.slice();
        } else {
            correctSequence = items.slice();
        }

        // Fisher-Yates shuffle for display order
        var shuffled = items.slice();
        for (var si = shuffled.length - 1; si > 0; si--) {
            var sj = Math.floor(Math.random() * (si + 1));
            var tmp = shuffled[si]; shuffled[si] = shuffled[sj]; shuffled[sj] = tmp;
        }
        // Re-shuffle if identical to correctSequence (avoid presenting already-ordered items)
        var attempts = 5;
        while (attempts-- > 0 && shuffled.every(function(itm, idx) { return itm === correctSequence[idx]; })) {
            for (var si2 = shuffled.length - 1; si2 > 0; si2--) {
                var sj2 = Math.floor(Math.random() * (si2 + 1));
                var tmp2 = shuffled[si2]; shuffled[si2] = shuffled[sj2]; shuffled[sj2] = tmp2;
            }
        }

        // correctOrder[i] = index in shuffled where correctSequence[i] is located
        var correctOrder = correctSequence.map(function(item) { return shuffled.indexOf(item); });

        return { items: shuffled, correctOrder: correctOrder, correctSequence: correctSequence };
    }

    static buildOrderingExplanation(correctSequence, llmExplanation) {
        if (!correctSequence || !correctSequence.length) return llmExplanation || '';
        var isDesc = false;
        if (correctSequence.length >= 2) {
            var f = QuizMathValidator._parseDecimal(String(correctSequence[0]).replace(/[^\d.,-]/g, ''));
            var l = QuizMathValidator._parseDecimal(String(correctSequence[correctSequence.length - 1]).replace(/[^\d.,-]/g, ''));
            if (f && l) isDesc = f.gt(l);
        }
        var direction = isDesc ? 'descendente (mayor a menor)' : 'ascendente (menor a mayor)';
        var explanation = 'El orden correcto ' + direction + ' es: ' + correctSequence.join(' > ');
        return explanation;
    }

    static _stripOrderingClaims(text) {
        if (!text) return text;
        return text
            .replace(/(?:el\s+)?orden\s+(?:correcto|es|ser\xeda)[^.]*\./gi, '')
            .replace(/(?:de\s+)?(?:mayor|menor)\s+a\s+(?:mayor|menor)[^.]*\./gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

}

export default QuizMathValidator;
