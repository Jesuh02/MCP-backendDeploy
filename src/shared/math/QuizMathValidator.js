import Decimal from 'decimal.js';

Decimal.set({ precision: 64 });

const MATH_SIGNALS = /calcula|suma|total|multiplica|divide|resta|resultado|costo\s+total|precio\s+total|monto\s+total|redondea|¿cuánto|cuántos|cuántas|promedio|media|porcentaje/i;
const HAS_SIGNIFICANT_NUMBERS = /\d{3,}/;

export class QuizMathValidator {

    static verify(q) {
        if (!q) return q;
        const text = q.question;
        if (!text || typeof text !== 'string') return q;
        const lower = text.toLowerCase();

        if (!MATH_SIGNALS.test(lower) && !HAS_SIGNIFICANT_NUMBERS.test(text.replace(/,/g, ''))) return q;

        try {
            const result = QuizMathValidator.computeExpectedAnswer(text);
            if (!result) return q;

            const finalAnswer = QuizMathValidator._applyDecimals(result.value, text);

            if (q.type === 'fill_in_blank') {
                return QuizMathValidator._verifyFillInBlank(q, finalAnswer, result.steps);
            }
            if (q.type === 'multiple_choice') {
                return QuizMathValidator._verifyMultipleChoice(q, finalAnswer, result.steps);
            }
        } catch (err) {
            console.warn(`[MathVerify] Error (non-blocking): ${err.message}`);
        }
        return q;
    }

    static computeExpectedAnswer(text) {
        return QuizMathValidator._tryExplicitArithmetic(text) ||
            QuizMathValidator._tryWordProblem(text) ||
            QuizMathValidator._trySumFallback(text) ||
            null;
    }

    // ── Private: question-type verifiers ──────────────────────────────────

    static _verifyFillInBlank(q, finalAnswer, steps) {
        const current = QuizMathValidator._parseDecimal(String(q.correctAnswer));
        if (!current) return q;

        if (!current.equals(finalAnswer)) {
            const isSignificant = current.minus(finalAnswer).abs().gt(
                Decimal.max(finalAnswer.abs().times('0.001'), '0.01')
            );
            if (isSignificant) {
                console.warn(`🔧 [MathVerify] CORRECTED fill_in_blank: LLM="${q.correctAnswer}" → Correct="${finalAnswer}"`);
            }
            q.correctAnswer = finalAnswer.toFixed();
            q.explanation = `${steps.join('. ')}. Resultado final: ${finalAnswer}.`;
        }
        return q;
    }

    static _verifyMultipleChoice(q, finalAnswer, steps) {
        if (!Array.isArray(q.options) || q.options.length === 0) return q;
        const optionValues = q.options.map(opt => {
            const clean = String(opt).replace(/,/g, '');
            const nums = clean.match(/\d+\.?\d*/g);
            if (!nums) return null;
            const parsed = nums.map(n => QuizMathValidator._parseDecimal(n)).filter(Boolean);
            return parsed.length > 0 ?
                parsed.reduce((a, b) => a.abs().gt(b.abs()) ? a : b) :
                null;
        });

        let closestIdx = -1;
        let closestDiff = new Decimal(Infinity);
        for (let i = 0; i < optionValues.length; i++) {
            if (!optionValues[i]) continue;
            const diff = optionValues[i].minus(finalAnswer).abs();
            if (diff.lt(closestDiff)) { closestDiff = diff;
                closestIdx = i; }
        }

        const tolerance = Decimal.max(finalAnswer.abs().times('0.001'), '0.01');
        if (closestIdx >= 0 && closestDiff.lte(tolerance)) {
            if (closestIdx !== q.correctIndex) {
                console.warn(`🔧 [MathVerify] CORRECTED MC: index ${q.correctIndex}→${closestIdx} (computed=${finalAnswer})`);
                q.correctIndex = closestIdx;
                q.explanation = `${steps.join('. ')}. Resultado final: ${finalAnswer}.`;
            }
            return q;
        }
        console.warn(`🔧 [MathVerify] REJECTED: No option ≈ computed=${finalAnswer}`);
        return null;
    }

    // ── Strategy 1: Explicit arithmetic "12,345 + 9,876 + ..." ───────────

    static _tryExplicitArithmetic(text) {
        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
        const numberPat = '\\d[\\d,]*\\.?\\d*';
        const opPat = '[+\\-×*÷/]';
        const exprRegex = new RegExp(
            `(${numberPat})\\s*(${opPat})\\s*(${numberPat}(?:\\s*${opPat}\\s*${numberPat})*)`, 'g'
        );
        const match = exprRegex.exec(cleaned);
        if (!match) return null;

        const tokens = match[0].split(/\s*([+\-×*÷/])\s*/).filter(t => t.trim());
        let result = QuizMathValidator._parseDecimal(tokens[0]);
        if (!result) return null;

        const steps = [];
        for (let i = 1; i < tokens.length; i += 2) {
            const op = tokens[i];
            const num = QuizMathValidator._parseDecimal(tokens[i + 1]);
            if (!num) return null;

            const prev = result;
            switch (op) {
                case '+':
                    result = result.plus(num);
                    break;
                case '-':
                    result = result.minus(num);
                    break;
                case '×':
                case '*':
                    result = result.times(num);
                    break;
                case '÷':
                case '/':
                    if (num.isZero()) { console.warn('[MathVerify] Division by zero'); return null; }
                    result = result.div(num);
                    break;
                default:
                    return null;
            }
            steps.push(`${prev} ${op} ${num} = ${result}`);
        }

        const afterExpr = cleaned.substring(cleaned.indexOf(match[0]) + match[0].length);
        const followUp = QuizMathValidator._detectFollowUpOperation(afterExpr);
        if (followUp) {
            const prev = result;
            result = followUp.apply(result);
            steps.push(followUp.describe(prev, result));
        }

        return { value: result, steps };
    }

    // ── Strategy 2: Word problem ─────────────────────────────────────────

    static _tryWordProblem(text) {
        const lower = text.toLowerCase();
        if (!/total|suma|calcula|acumulad|promedio|media|¿cuánto|cuántos|monto|resultado/i.test(lower)) return null;

        const dataNumbers = QuizMathValidator._extractDataNumbers(text);
        if (dataNumbers.length < 2) return null;

        const steps = [];
        let result;

        if (/promedio|media\b/i.test(lower)) {
            const sum = dataNumbers.reduce((a, b) => a.plus(b), new Decimal(0));
            result = sum.div(dataNumbers.length);
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${sum}`);
            steps.push(`Promedio: ${sum} / ${dataNumbers.length} = ${result}`);
        } else {
            result = dataNumbers.reduce((a, b) => a.plus(b), new Decimal(0));
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${result}`);
        }

        result = QuizMathValidator._applyRate(text, result, steps);
        result = QuizMathValidator._applyPercentage(text, result, steps);
        result = QuizMathValidator._applyPostAddition(text, result, dataNumbers, steps);

        return steps.length > 0 ? { value: result, steps } : null;
    }

    // ── Strategy 3: Sum fallback ─────────────────────────────────────────

    static _trySumFallback(text) {
        const lower = text.toLowerCase();
        if (!/(?:total|suma|calcula|resultado|¿cuánto|cuántos|monto|costo|precio|valor)/i.test(lower)) return null;

        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
        const pctValues = QuizMathValidator._extractPercentages(text);

        const numRe = /\d[\d,]*\.?\d*/g;
        let nm;
        const candidates = [];
        while ((nm = numRe.exec(cleaned)) !== null) {
            const val = QuizMathValidator._parseDecimal(nm[0]);
            if (!val) continue;
            if (pctValues.some(p => p.equals(val))) continue;
            if (val.lte(5)) continue;
            const n = val.toNumber();
            if (n >= 1900 && n <= 2100 && val.isInteger()) continue;
            candidates.push(val);
        }
        if (candidates.length < 2) return null;

        const sorted = [...candidates].sort((a, b) => a.cmp(b));
        const largest = sorted[sorted.length - 1];
        const dataNumbers = sorted.filter(n => n.gte(largest.times('0.001')) && n.gte(10));
        if (dataNumbers.length < 2) return null;

        const steps = [];
        let result;

        if (/promedio|media\b/i.test(lower)) {
            const sum = dataNumbers.reduce((a, b) => a.plus(b), new Decimal(0));
            result = sum.div(dataNumbers.length);
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${sum}`);
            steps.push(`Promedio: ${sum} / ${dataNumbers.length} = ${result}`);
        } else {
            result = dataNumbers.reduce((a, b) => a.plus(b), new Decimal(0));
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${result}`);
        }

        // Apply percentage
        if (pctValues.length > 0) {
            const pct = pctValues[0];
            if (pct.gt(0) && pct.lte(200)) {
                const prev = result;
                if (/descuento/i.test(lower)) {
                    const factor = new Decimal(1).minus(pct.div(100));
                    result = result.times(factor);
                    steps.push(`Descuento ${pct}%: ${prev} × ${factor} = ${result}`);
                } else if (/impuesto|iva|incremento|aumento|interés|recargo/i.test(lower)) {
                    const factor = new Decimal(1).plus(pct.div(100));
                    result = result.times(factor);
                    steps.push(`+ ${pct}%: ${prev} × ${factor} = ${result}`);
                }
            }
        }

        result = QuizMathValidator._applyRate(text, result, steps);
        result = QuizMathValidator._applyPostAddition(text, result, candidates, steps);

        return steps.length > 0 ? { value: result, steps } : null;
    }

    // ── Shared helpers ───────────────────────────────────────────────────

    static _parseDecimal(str) {
        if (!str) return null;
        try {
            const d = new Decimal(String(str).replace(/,/g, ''));
            return d.isFinite() ? d : null;
        } catch { return null; }
    }

    static _applyDecimals(value, text) {
        const match = text.match(/redonde[ao].*?(\d+)\s*decimal/i) ||
            text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i);
        if (match) return value.toDecimalPlaces(parseInt(match[1]));
        return value;
    }

    static _extractPercentages(text) {
        const pctRe = /([\d,.]+)\s*%/g;
        const result = [];
        let m;
        while ((m = pctRe.exec(text)) !== null) {
            const d = QuizMathValidator._parseDecimal(m[1]);
            if (d) result.push(d);
        }
        return result;
    }

    static _extractDataNumbers(text) {
        const dataNumbers = [];
        let m;

        // Pattern 1: labeled numbers — "Label: $12,345.67"
        const labeledPat = /(?:[a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ\s]*[:=]\s*\$?)([\d,]+\.?\d*)/gi;
        while ((m = labeledPat.exec(text)) !== null) {
            const d = QuizMathValidator._parseDecimal(m[1]);
            if (d && d.gte(10)) dataNumbers.push(d);
        }

        // Pattern 1b: currency "$45,230"
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const currencyPat = /\$\s?([\d,]+\.?\d*)/gi;
            while ((m = currencyPat.exec(text)) !== null) {
                const d = QuizMathValidator._parseDecimal(m[1]);
                if (d && d.gte(1)) dataNumbers.push(d);
            }
        }

        // Pattern 1c: "de" amounts
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const dePat = /(?:de|por|con|=)\s*\$?\s*([\d,]+\.?\d*)/gi;
            while ((m = dePat.exec(text)) !== null) {
                const d = QuizMathValidator._parseDecimal(m[1]);
                if (d && d.gte(10)) dataNumbers.push(d);
            }
        }

        // Pattern 2: all significant numbers ≥ 10
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const stripped = text.replace(/[$€¥£₡₿]\s*/g, '');
            const allNums = stripped.match(/\d[\d,]*\.?\d*/g) || [];
            const pctSet = new Set(QuizMathValidator._extractPercentages(text).map(d => d.toString()));
            for (const raw of allNums) {
                const d = QuizMathValidator._parseDecimal(raw);
                if (!d || d.lt(10)) continue;
                if (pctSet.has(d.toString())) continue;
                const n = d.toNumber();
                if (n >= 1900 && n <= 2100 && d.isInteger()) continue;
                dataNumbers.push(d);
            }
        }

        return dataNumbers;
    }

    static _applyRate(text, result, steps) {
        const ratePatterns = [
            /costo\s+(?:de\s+(?:procesamiento|producción|envío|operación|mantenimiento))?\s*(?:de|es|por|=)?\s*\$?([\d,.]+)/i,
            /precio\s+(?:de|por|unitario|cada)?\s*\$?([\d,.]+)/i,
            /cada\s+\w+\s+(?:tiene\s+)?(?:un\s+)?(?:costo|precio|valor)\s+(?:de\s*)?\$?([\d,.]+)/i,
            /(?:multiplic[aá]r?|×)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /(?:tasa|tarifa|factor|coeficiente)\s+(?:de\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /\$\s*([\d,.]+)\s*(?:por|\/)\s*(?:cada|unidad|GB|kg|litro|km|hora)/i,
        ];
        for (const re of ratePatterns) {
            const rm = text.match(re);
            if (rm) {
                const rate = QuizMathValidator._parseDecimal(rm[1]);
                if (rate && rate.gt(0) && rate.lt(result)) {
                    const prev = result;
                    result = result.times(rate);
                    steps.push(`Costo/Multiplicación: ${prev} × ${rate} = ${result}`);
                    break;
                }
            }
        }
        return result;
    }

    static _applyPercentage(text, result, steps) {
        const pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA|ISR|interés)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (!pctMatch) return result;

        const pct = QuizMathValidator._parseDecimal(pctMatch[1]);
        if (!pct || pct.lte(0) || pct.gt(200)) return result;

        const prev = result;
        if (/descuento/i.test(pctMatch[0])) {
            const factor = new Decimal(1).minus(pct.div(100));
            result = result.times(factor);
            steps.push(`Descuento ${pct}%: ${prev} × ${factor} = ${result}`);
        } else {
            const factor = new Decimal(1).plus(pct.div(100));
            result = result.times(factor);
            steps.push(`+ ${pct}%: ${prev} × ${factor} = ${result}`);
        }
        return result;
    }

    static _applyPostAddition(text, result, excludeNumbers, steps) {
        const addMatch = text.match(/(?:se\s+)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (!addMatch) return result;

        const addVal = QuizMathValidator._parseDecimal(addMatch[1]);
        if (!addVal || addVal.lte(0)) return result;

        const isDuplicate = excludeNumbers.some(n =>
            (n instanceof Decimal ? n.equals(addVal) : new Decimal(n).equals(addVal))
        );
        if (isDuplicate) return result;

        const prev = result;
        result = result.plus(addVal);
        steps.push(`Adición: ${prev} + ${addVal} = ${result}`);
        return result;
    }

    static _detectFollowUpOperation(text) {
        if (!text) return null;

        const multPatterns = [
            /(?:multiplic[aá]r?\s+por|×)\s*\$?([\d,.]+)/i,
            /(?:costo|precio|tarifa|tasa)\s+(?:de\s+(?:\w+\s+)*)?(?:de\s*)?\$?([\d,.]+)/i,
            /cada\s+\w+\s+.*?\$?([\d,.]+)/i,
        ];
        for (const re of multPatterns) {
            const m = text.match(re);
            if (m) {
                const factor = QuizMathValidator._parseDecimal(m[1]);
                if (factor && factor.gt(0)) {
                    return {
                        apply: (v) => v.times(factor),
                        describe: (prev, result) => `Multiplicación: ${prev} × ${factor} = ${result}`,
                    };
                }
            }
        }

        const pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (pctMatch) {
            const pct = QuizMathValidator._parseDecimal(pctMatch[1]);
            if (pct && pct.gt(0)) {
                const isDiscount = /descuento/i.test(pctMatch[0]);
                const factor = isDiscount ?
                    new Decimal(1).minus(pct.div(100)) :
                    new Decimal(1).plus(pct.div(100));
                return {
                    apply: (v) => v.times(factor),
                    describe: (prev, result) => `${isDiscount ? 'Descuento' : 'Incremento'} ${pct}%: ${prev} × ${factor} = ${result}`,
                };
            }
        }

        return null;
    }
}

export default QuizMathValidator;