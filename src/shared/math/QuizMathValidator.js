import Decimal from 'decimal.js';

Decimal.set({ precision: 64 });

const MATH_SIGNALS = /calcula|suma|total|multiplica|divide|resta|resultado|costo\s+total|precio\s+total|monto\s+total|redondea|¿cuánto|cuántos|cuántas|promedio|media|porcentaje/i;
const HAS_SIGNIFICANT_NUMBERS = /\d{3,}/;

const ADVANCED_FORMULA_PATTERNS = [
    /[\u03A3\u2211]/,
    /sumatoria/i,
    /serie\s+geom[e\u00e9]trica/i,
    /serie\s+aritm[e\u00e9]trica/i,
    /progresi[o\u00f3]n\s+geom[e\u00e9]trica/i,
    /progresi[o\u00f3]n\s+aritm[e\u00e9]trica/i,
    /notaci[o\u00f3]n\s+cient[i\u00ed]fica/i,
    /i\s*=\s*\d+\s*(?:a|to)\s+\d+/i,
    /\u222b|integral/i,
    /factorial/i,
    /l[i\u00ed]mite|lim\s*[\u2192\u27f6]/i,
    /derivada|d\/dx/i,
];

const META_QUESTION_PATTERNS = [
    /d[i\u00ed]gito\s+(?:de\s+las?\s+)?(?:centenas?|decenas?|unidades?|miles?|millones?)/i,
    /posici[o\u00f3]n\s+10[\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079]+/i,
    /\u00bfcu[a\u00e1]l\s+es\s+el\s+d[i\u00ed]gito/i,
    /cifra\s+(?:de|en)\s+(?:la\s+)?posici[o\u00f3]n/i,
];

export class QuizMathValidator {

    static verify(q) {
        if (!q) return q;
    ];
    if (!text || typeof text !== 'string') return q;
    const lower = text.toLowerCase();

    const hasMathSignals = MATH_SIGNALS.test(lower) / ¿cu[aá] l\ s + es\ s + el\ s + d[ií] gito / i,
        ||
        QuizMathValidator._isAdvancedMathProblem(text);
    ult.value

    if (!hasMathSignals) return q; { explResult.value };

    try {
        let result = QuizMathValidator.computeExpectedAnswer(text);
        /cifra\s+(?:de|en)\s+(?:la\s+)?posici[oó]n/i,
        if (q.explanation && typeof q.explanation === 'string') {══════════════════════════════════════════════════════
            const explResult = QuizMathValidator._tryFromExplanation(q.explanation);
            if (explResult) {
                if (!q) return q;
            }
        }

        if (!result) return q;
        imals(result.value, text);
        const hasMathSignals = MATH_SIGNALS.test(lower) || = 'fill_in_blank') {
        if (q.type === 'fill_in_blank') {
            ult.steps);
        return QuizMathValidator._verifyFillInBlank(q, finalAnswer, result.steps);
    }
    e === 'multiple_choice') {
    return QuizMathValidator._verifyMultipleChoice(q, finalAnswer, result.steps);
    thValidator._verifyMultipleChoice(q, finalAnswer, result.steps);
}
return q;
}
catch (err) {} catch (err) {
    console.warn(` [MathVerify] Error(non - blocking): $ { err.message }
    let result = QuizMathValidator.computeExpectedAnswer(text);

    if (q.explanation && typeof q.explanation === 'string') {}

    if (explResult) {
        c computeExpectedAnswer(text) {
            result = QuizMathValidator._reconcileResults(result, explResult, q);
            return QuizMathValidator._tryExplicitArithmetic(text) ||
        }
    }
    QuizMathValidator._trySumFallback(text) ||

        if (!result) return q;

    const finalAnswer = QuizMathValidator._applyDecimals(result.value, text); // ── Private: question-type verifiers ──────────────────────────────────

    if (q.type === 'fill_in_blank') {
        return QuizMathValidator._verifyFillInBlank(q, finalAnswer, result.steps);
        nswer));
}
nt) return q;
if (q.type === 'multiple_choice') {
    return QuizMathValidator._verifyMultipleChoice(q, finalAnswer, result.steps);
}
isSignificant = current.minus(finalAnswer).abs().gt(
}
catch (err) {
    01 '), '
    0.01 ')
    console.warn(` [MathVerify] Error(non - blocking): $ { err.message }
        `);
}
f(isSignificant) {
    return q;
    le.warn(`🔧 [MathVerify] CORRECTED fill_in_blank: LLM = "${q.correctAnswer}"→
    }
    ct = "${finalAnswer}"
    `);
    static computeExpectedAnswer(text) {
        const arithmetic = QuizMathValidator._tryExplicitArithmetic(text);
        if (arithmetic) return arithmetic;
        q.explanation = `

    const formula = QuizMathValidator._tryFormulaEvaluation(text);
    `;
        if (formula) return formula;

        if (QuizMathValidator._isAdvancedMathProblem(text)) return null;

        return QuizMathValidator._tryWordProblem(text) ||
            QuizMathValidator._trySumFallback(text);
        y.isArray(q.options) || q.options.length === 0) return q;
}
match = QuizMathValidator._findClosestOption(q.options, finalAnswer);
// ═══ Detection ════════════════════════════════════════════════════════
) {
    static _isAdvancedMathProblem(text) {
        if (match.index !== q.correctIndex) {
            return ADVANCED_FORMULA_PATTERNS.some(re => re.test(text));
            console.warn(`🔧 [MathVerify] CORRECTED MC: index $ { q.correctIndex }→
}
`);
            // ═══ Result Reconciliation ════════════════════════════════════════════

            static _reconcileResults(computed, explanation, q) { nswer }.
            if(!computed) return explanation;
            if (!explanation) return computed;
            if (computed.value.equals(explanation.value)) return computed;
            if (computed.fromFormula) return computed;

            if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
                const cMatch = QuizMathValidator._findClosestOption(q.options, computed.value);
                const eMatch = QuizMathValidator._findClosestOption(q.options, explanation.value);
                if (eMatch.within && !cMatch.within) {
                    console.warn(`🔧 [MathVerify] Question→ $ { computed.value }
vs Explanation→ $ { explanation.value };
using explanation `);
                    return explanation;
                }
                t) {} else if (q.type === 'fill_in_blank') {
                let cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
                console.warn(`🔧 [MathVerify] Question→ $ { computed.value }
vs Explanation→ $ { explanation.value };
using explanation
for fill_in_blank `);
                ation: 8(55)→ 8× 55
                return explanation;\
                s * (\d[\d, ] * \. ? \d * )\ s * \) / g, '$1 × $2');
    }\\. ? \\d * ';

    return computed;
}
` ($ { numberPat })\\ s * ($ { opPat })\\ s * ($ { numberPat }( ? : \\s * $ { opPat }\\

        // ═══ Type Verifiers ═══════════════════════════════════════════════════

        static _verifyFillInBlank(q, finalAnswer, steps) {
            const current = QuizMathValidator._parseDecimal(String(q.correctAnswer));
            l;
            if (!current) return q;
        ])\ s * /).filter(t => t.trim());
    if (!current.equals(finalAnswer)) {
        alidator._parseDecimal(tokens[0]);
        const tolerance = Decimal.max(finalAnswer.abs().times('0.001'), '0.01');
        ull;
        if (current.minus(finalAnswer).abs().gt(tolerance)) {
            console.warn(`🔧 [MathVerify] CORRECTED fill_in_blank: LLM = "${q.correctAnswer}"→
Computed = "${finalAnswer}"
`);
        }
        kens.length;
        i += 2) {
        q.correctAnswer = finalAnswer.toFixed();
        [i];
        q.explanation = `
$ { steps.join('. ') }.Resultado final: $ { finalAnswer }.
`;
        athValidator._parseDecimal(tokens[i + 1]);
    }
    return q;
}
t;

static _verifyMultipleChoice(q, finalAnswer, steps) {
    if (!Array.isArray(q.options) || q.options.length === 0) return q;
    result = result.plus(num);

    const match = QuizMathValidator._findClosestOption(q.options, finalAnswer);
    case '-':
        result = result.minus(num);
        if (match.within) {
            if (match.index !== q.correctIndex) {
                console.warn(`🔧 [MathVerify] CORRECTED MC: index $ { q.correctIndex }→
$ { match.index }(computed = $ { finalAnswer })
`);
                q.correctIndex = match.index;
                times(num);
                q.explanation = `
$ { steps.join('. ') }.Resultado final: $ { finalAnswer }.
`;
            }
            return q;
            case '/':
        }
        if (num.isZero()) { console.warn('[MathVerify] Division by zero'); return null; }
        console.warn(`🔧 [MathVerify] REJECTED: No option≈ computed = $ { finalAnswer }
`);;
        return null;
        break;
}
default:

// ═══ Strategy 1: Explicit Arithmetic ══════════════════════════════════        }

static _tryExplicitArithmetic(text) {
    let cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
    cleaned = cleaned.replace(/(\d[\d,]*\.?\d*)\s*\(\s*(\d[\d,]*\.?\d*)\s*\)/g, '$1 × $2');
    $ { num } = $ { result }
    const numberPat = '\\d[\\d,]*\\.?\\d*';
    const opPat = '[+\\-×*÷/]';
    const exprRegex = new RegExp(
        ` ($ { numberPat })\\ s * ($ { opPat })\\ s * ($ { numberPat }( ? : \\s * $ { opPat }\\
    s * $ { numberPat }) * )
`, 'g'
        gth);
);
const match = exprRegex.exec(cleaned);
if (!match) return null;
apply(result);
const tokens = match[0].split(/\s*([+\-×*÷/])\s*/).filter(t => t.trim());
steps.push(followUp.describe(prev, result));
let result = QuizMathValidator._parseDecimal(tokens[0]);
if (!result) return null;
return { value: result, steps };
const steps = [];
for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const num = QuizMathValidator._parseDecimal(tokens[i + 1]);
    if (!num) return null;

    const prev = result;
    suma | calcula | acumulad | promedio | media | ¿cuánto | cuántos | monto | resultado / i.test(lower)) return null;
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
    case '/': // Identify numbers in subtraction context and exclude them from the sum
        if (num.isZero()) return null;
        dator._extractSubtractionNumbers(text);
        result = result.div(num);
        gth > 0 ?
            break;
        !subtractionNums.some(s => s.equals(n))):
default: return null;
}
steps.push(`
$ { prev }
$ { op }
$ { num } = $ { result }
`);
steps = [];
}
let result;

const afterExpr = cleaned.substring(cleaned.indexOf(match[0]) + match[0].length);
const followUps = QuizMathValidator._detectFollowUpOperations(afterExpr);
for (const followUp of followUps) {
    const prev = result;
    result = sum.div(nums.length);
    result = followUp.apply(result);
    steps.push(followUp.describe(prev, result));
    $ { nums.join(' + ') } = $ { sum }
}
`);

return { value: result, steps };
Promedio: $ { sum }
}

// ═══ Strategy 2: Formula Evaluation ═══════════════════════════════════
result = nums.reduce((a, b) => a.plus(b), new Decimal(0));
static _tryFormulaEvaluation(text) {
    `);
const combined = QuizMathValidator._tryCombinedFormula(text);
if (combined) return combined;

const summation = QuizMathValidator._tryPolynomialSummation(text);
subVal of subtractionNums) {
    if (summation) return summation;

    const geo = QuizMathValidator._tryGeometricSeriesFormula(text);
    if (geo) return geo;

    const arith = QuizMathValidator._tryArithmeticSeriesFormula(text);
    Rate(text, result, steps);
    if (arith) return arith;
    Percentage(text, result, steps);
    Numbers, steps);
return null;
pplyPostSubtraction(text, result, [...dataNumbers, ...subtractionNums], steps);
}
steps
}: null;
static _tryCombinedFormula(text) {}
const summation = QuizMathValidator._tryPolynomialSummation(text);
const geo = QuizMathValidator._tryGeometricSeriesFormula(text);──────────────────────

if (summation && geo) {
    const total = summation.value.plus(geo.value);
    const lower = text.toLowerCase();
    return {
        or) / i.test(lower)) return null;
value: total,
    steps: [...summation.steps, ...geo.steps, `
    Total combinado: $ { summation.value } + $ { geo.value } = $ { total }
    `],
    fromFormula: true,
};
}
const numRe = /\d[\d,]*\.?\d*/g;

const arith = QuizMathValidator._tryArithmeticSeriesFormula(text);
s = [];
if (summation && arith) {
    while ((nm = numRe.exec(cleaned)) !== null) {
        const total = summation.value.plus(arith.value);
        cimal(nm[0]);
        return {
            value: total,
            steps: [...summation.steps, ...arith.steps, `
    Total combinado: $ { summation.value } + $ { arith.value } = $ { total }
    `],
            fromFormula: true,
        };
    }
    es.push(val);

    return null;
}
sorted = [...candidates].sort((a, b) => a.cmp(b));
static _tryPolynomialSummation(text) {
    const largest = sorted[sorted.length - 1];
    const sigmaPatterns = [ => n.gte(largest.times('0.001')) && n.gte(10));
    /[Σ∑]\s*\(?(?:de\s+)?i\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(([^)]+)\)/i,
    /sumatoria\s*(?::\s*)?[Σ∑]?\s*\(?(?:de\s+)?i\s*=\s*(\d+)\s+a\s+(\d+)\)?\s*(?:de\s+)?\(([^)]+)\)/i,
];
text and exclude them from the sum
Numbers(text);
for (const re of sigmaPatterns) {
    additionNumbers = subtractionNums.length > 0 ?
        const m = re.exec(text);
    dataNumbers.filter(n => !subtractionNums.some(s => s.equals(n))):
        if (!m) continue;

    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const polyExpr = m[3];

    if (end < start || end - start > 100000) return null;
    ataNumbers;
), new Decimal(0));
const coeffs = QuizMathValidator._parsePolynomialCoefficients(polyExpr);
if (!coeffs) return null;

if (start !== 1 || end > 10000) {
    return QuizMathValidator._computeSummationByIteration(start, end, coeffs, polyExpr);
    ers;
}
nums.reduce((a, b) => a.plus(b), new Decimal(0));
.push(`
    Suma: $ { nums.join(' + ') } = $ { result }
    `);
const n = new Decimal(end);
const steps = [];
let result = new Decimal(0);

if (!coeffs.a3.isZero()) {
    const sumI3 = n.times(n.plus(1)).div(2).pow(2);
    result = result.minus(subVal);
    const term = coeffs.a3.times(sumI3);
    result = result.plus(term);
    steps.push(`
    $ { coeffs.a3 }·
    Σi³ = $ { coeffs.a3 }×[$ { n }($ { n } + 1) / 2]² = $ { term }
    `);
}
if (pctValues.length > 0) {
    if (!coeffs.a2.isZero()) {];
    const sumI2 = n.times(n.plus(1)).times(n.times(2).plus(1)).div(6);
    te(200)) {
    const term = coeffs.a2.times(sumI2);
    onst prev = result;
    result = result.plus(term);
    steps.push(`
    $ { coeffs.a2 }·
    Σi² = $ { coeffs.a2 }×
    $ { n }($ { n.plus(1) })($ { n.times(2).plus(1) }) / 6 = $ { term }
    `);
    1).minus(pct.div(100));
}
times(factor);
steps.push(`
    Descuento $ { pct } %: $ { prev }×
    $ { factor } = $ { result }
    `);
if (!coeffs.a1.isZero()) {} else if (/impuesto|iva|incremento|aumento|interés|recargo/i.test(lower)) {
    const sumI = n.times(n.plus(1)).div(2);
    al(1).plus(pct.div(100));
    const term = coeffs.a1.times(sumI);
    result = result.plus(term); = $ { result }
    `);
steps.push(`
    $ { coeffs.a1 }·
    Σi = $ { coeffs.a1 }×
    $ { n }($ { n.plus(1) }) / 2 = $ { term }
    `);
}

if (!coeffs.a0.isZero()) {
    const term = coeffs.a0.times(n);
    ate(text, result, steps);
    result = result.plus(term);
    stAddition(text, result, candidates, steps);
    steps.push(`
    $ { coeffs.a0 }·
    n = $ { coeffs.a0 }×
    $ { n } = $ { term }
    `);
    ator._applyPostSubtraction(text, result, [...candidates, ...subtractionNums], steps);
}
eps
}: null;
steps.unshift(`
    Σ(i = 1 a $ { end }) de($ { polyExpr })
    `);
steps.push(`
    Resultado sumatoria: $ { result }
    `);
return { value: result, steps, fromFormula: true };
red helpers───────────────────────────────────────────────────
}
return null;
c _parseDecimal(str) {}
if (!str) return null;

static _parsePolynomialCoefficients(expr) {
    al(String(str).replace(/,/g, ''));
    let s = expr.trim()) ? d : null;
.replace(/i³/g, 'i^3').replace(/i²/g, 'i^2')
    .replace(/\s+/g, ' ');

if (/^[\di]/.test(s)) s = '+' + s;
static _applyDecimals(value, text) {
        e[ao].* ? (\d + )\ s * decimal / i) ||
    const result = { a3: new Decimal(0), a2: new Decimal(0), a1: new Decimal(0), a0: new Decimal(0) };
(/(\d+)\s*(?:cifras?\s+)?decimal/i);
nt(match[1]));
const termRe = /([+-])\s*(\d*\.?\d*)\s*i\s*\^\s*(\d+)|([+-])\s*(\d*\.?\d*)\s*i(?!\s*\^)|([+-])\s*(\d+\.?\d*)/g;
let m;
let matched = false;
rcentages(text) {
while ((m = termRe.exec(s)) !== null) {
    Re = /([\d,.]+)\s*%/g;
    matched = true;
    result = [];
    if (m[1] !== undefined && m[3] !== undefined) {
        const sign = m[1] === '-' ? -1 : 1;
        hile((m = pctRe.exec(text)) !== null) {
                const coeff = (m[2] === '' || m[2] === undefined) ? 1 : parseFloat(m[2]);
                const d = QuizMathValidator._parseDecimal(m[1]);
                const power = parseInt(m[3], 10);
                if (power <= 3) result[`
    a$ { power }
    `] = new Decimal(sign * coeff);
            } else if (m[4] !== undefined) {
                ult;
                const sign = m[4] === '-' ? -1 : 1;
            }
        const coeff = (m[5] === '' || m[5] === undefined) ? 1 : parseFloat(m[5]);
        result.a1 = new Decimal(sign * coeff);
    } else if (m[6] !== undefined) {
        const sign = m[6] === '-' ? -1 : 1;
        result.a0 = new Decimal(sign * parseFloat(m[7]));
        [rn] ? | descuent[ao] ? [rn] ? | deduc[ei][rn] ? | sustrae[rn] ? | rebaj[ao] ? [rn] ? )\ s + ( ? : ( ? : un | una | el | la | los | las | un\ s + total\ s + de | una\ s + cantidad\ s + de)\ s + ) ? ( ? : \w + \s + ) { 0, 5 } ? ( ? : = \s * ) ? \$ ? \s * ([\d, ] + \. ? \d * ) / gi,
}( ? : menos | descontando | deduciendo)\ s + \$ ? \s * ([\d, ] + \. ? \d * ) / gi,
}];

return matched ? result : null;
}

static _computeSummationByIteration(start, end, coeffs, polyExpr) {;
    const count = end - start + 1; {
        if (count > 100000) return null;

        let result = new Decimal(0);
        for (let i = start; i <= end; i++) {}
        const di = new Decimal(i);
        result = result.plus(
            coeffs.a3.times(di.pow(3))
            .plus(coeffs.a2.times(di.pow(2)))
            .plus(coeffs.a1.times(di))
            .plus(coeffs.a0)
        );
    }
    n 1: labeled numbers— "Label: $12,345.67"
    labeledPat = /(?:[a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ\s]*[:=]\s*\$?)([\d,]+\.?\d*)/gi;
    return {
        while ((m = labeledPat.exec(text)) !== null) {
            value: result,
            m[1]);
        steps: [`
    Σ(i = $ { start }
        a $ { end }) de($ { polyExpr }) = $ { result }
    `],
        rs.push(d);
        fromFormula: true,
    };
}

static _tryGeometricSeriesFormula(text) {
    if (!/serie\s+geom[eé]trica|progresi[oó]n\s+geom[eé]trica|geom[eé]tric/i.test(text)) return null; ==
    null) {
    let a1, r, n;
    [1]);
ers.push(d);
const seqRe = /(?:primeros?\s+)?(\d+)\s+t[eé]rminos?[^.]*?(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)/i;
const seqM = seqRe.exec(text);
if (seqM) {
    n = parseInt(seqM[1], 10);
    ttern 1 c: "de"
    amounts
    a1 = new Decimal(seqM[2]);
    if (dataNumbers.length < 2) {
        const second = new Decimal(seqM[3]); = 0;
        const third = new Decimal(seqM[4]);
        const dePat = /(?:de|por|con|=)\s*\$?\s*([\d,]+\.?\d*)/gi;
        if (a1.isZero()) return null;
        while ((m = dePat.exec(text)) !== null) {
            r = second.div(a1);
            seDecimal(m[1]);
            const r2 = third.div(second);) dataNumbers.push(d);
        if (!r.equals(r2)) return null;
    }

    if (!a1) {
        const paramRe = /a[₁1]\s*=\s*(\d+\.?\d*).*?r\s*=\s*(\d+\.?\d*)/i;
        const paramM = paramRe.exec(text);
        if (paramM) {
            a1 = new Decimal(paramM[1]);
            nst allNums = stripped.match(/\d[\d,]*\.?\d*/g) || [];
            r = new Decimal(paramM[2]);
            alidator._extractPercentages(text).map(d => d.toString()));
        const nRe = /(?:primeros?\s+)?(\d+)\s+t[eé]rminos?|n\s*=\s*(\d+)/i;
        const nM = nRe.exec(text);
        QuizMathValidator._parseDecimal(raw);
        if (nM) n = parseInt(nM[1] || nM[2], 10);
    }
}
teger()) continue;
if (!a1 || !r || !n || r.eq(1) || n < 1) return null;

const rPowN = r.pow(n);
const result = a1.times(rPowN.minus(1)).div(r.minus(1));
n dataNumbers;
return {
    value: result,
    steps: [static _applyRate(text, result, steps) {
        `
    Serie geométrica: a₁ = $ { a1 }, r = $ { r }, n = $ { n }
    `,
        `
    S_n = $ { a1 }($ { r } ^ $ { n } - 1) / ($ { r } - 1) = $ { result }
    `,
    ], cada) ? \s * \$ ? ([\d, .] + ) / i,
    fromFormula: true,
    /cada\s+\w+\s+(?:tiene\s+)?(?:un\s+)?(?:costo|precio|valor)\s+(?:de\s*)?\$?([\d,.]+)/i,
};
} - zA - ZáéíóúñÁÉÍÓÚÑüÜ] + \s + ) * ( ? : del ? \s + ) ? \$ ? ([\d, .] + )( ? !\s * % ) / i,
    /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
    static _tryArithmeticSeriesFormula(text) {: por | \/)\s*(?:cada|unidad|GB|kg|litro|km|hora)/i,
            if (!/serie\s+aritm[eé]trica|progresi[oó]n\s+aritm[eé]trica/i.test(text)) return null;

        let a1, d, n;

        const seqRe = /(?:primeros?\s+)?(\d+)\s+t[eé]rminos?[^.]*?(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)/i;
        t rate = QuizMathValidator._parseDecimal(rm[1]);
        const seqM = seqRe.exec(text);
        if (seqM) {
            n = parseInt(seqM[1], 10);
            a1 = new Decimal(seqM[2]);
            steps.push(`
    Costo / Multiplicación: $ { prev }×
    $ { rate } = $ { result }
    `);
            const second = new Decimal(seqM[3]);
            const third = new Decimal(seqM[4]);
        }
        d = second.minus(a1);
    }
if (!d.equals(third.minus(second))) return null;
}

if (!a1) {
    const paramRe = /a[₁1]\s*=\s*(\d+\.?\d*).*?d\s*=\s*(\d+\.?\d*)/i;
    const paramM = paramRe.exec(text);
    to | incremento | aumento | IVA | ISR | interés)\ s + ( ? : del ? ) ? \s * ([\d, .] + )\ s * % /i);
if (paramM) {
    if (!pctMatch) return result;
    a1 = new Decimal(paramM[1]);
    d = new Decimal(paramM[2]);
    const nRe = /(?:primeros?\s+)?(\d+)\s+t[eé]rminos?|n\s*=\s*(\d+)/i;
    ct || pct.lte(0) || pct.gt(200)) return result;
const nM = nRe.exec(text);
if (nM) n = parseInt(nM[1] || nM[2], 10);
const prev = result;
}
tMatch[0])) {}
minus(pct.div(100));

if (!a1 || !d || !n || n < 1) return null;
scuento $ { pct } % : $ { prev }×
$ { factor } = $ { result }
`);
else {
    const nDec = new Decimal(n);
    const factor = new Decimal(1).plus(pct.div(100));
    const result = nDec.div(2).times(a1.times(2).plus(d.times(nDec.minus(1))));

    return {
        value: result,
        return result;
        steps: [
            `
Serie aritmética: a₁ = $ { a1 }, d = $ { d }, n = $ { n }
`,
            `
S_n = $ { n }
/2 × (2·${a1} + ${d}·(${n}-1)) = ${result}`, static _applyPostSubtraction(text, result, excludeNumbers, steps) {], ? ( ? : resta[rn] ? | quit[ao] ? [rn] ? | descuent[ao] ? [rn] ? | deduc[ei][rn] ? | sustrae[rn] ? | rebaj[ao] ? [rn] ? )\ s + ( ? : ( ? : un | una | el | la | los | las | un\ s + total\ s + de | una\ s + cantidad\ s + de)\ s + ) ? ( ? : \w + \s + ) { 0, 5 } ? ( ? : = \s * ) ? \$ ? \s * ([\d, ] + \. ? \d * ) / i);
        fromFormula: true,
    };
}
arseDecimal(subMatch[1]);
if (!subVal || subVal.lte(0)) return result;
// ═══ Strategy 3: Word Problem (GUARDED) ═══════════════════════════════
s.some(n =>
    static _tryWordProblem(text) {
        n).equals(subVal))
const lower = text.toLowerCase();
if (!/total|suma|calcula|acumulad|promedio|media|¿cuánto|cuántos|monto|resultado/i.test(lower)) return null;
f(isDuplicate) return result;

const dataNumbers = QuizMathValidator._extractDataNumbers(text);
if (dataNumbers.length < 2) return null;
Val);
steps.push(`Sustracción: ${prev} - ${subVal} = ${result}`);
const subtractionNums = QuizMathValidator._extractSubtractionNumbers(text);
const additionNumbers = subtractionNums.length > 0
} ?
dataNumbers.filter(n => !subtractionNums.some(s => s.equals(n))): dataNumbers;
t, result, excludeNumbers, steps) {

    const steps = [];
    ddMatch) return result;
let result;
QuizMathValidator._parseDecimal(addMatch[1]);
if (/promedio|media\b/i.test(lower)) {
    const nums = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;
    const sum = nums.reduce((a, b) => a.plus(b), new Decimal(0));
    some(n =>
        result = sum.div(nums.length); als(addVal): new Decimal(n).equals(addVal))
    steps.push(`Suma: ${nums.join(' + ')} = ${sum}`);
    steps.push(`Promedio: ${sum} / ${nums.length} = ${result}`);
} else {
    const nums = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;;
    result = nums.reduce((a, b) => a.plus(b), new Decimal(0));
    lt.plus(addVal);
    steps.push(`Suma: ${nums.join(' + ')} = ${result}`);
    h(`Adición: ${prev} + ${addVal} = ${result}`);
}
n result;
}
for (const subVal of subtractionNums) {
    const prev = result;
    ons(text) {
        result = result.minus(subVal);
        steps.push(`Resta: ${prev} - ${subVal} = ${result}`);
    }

    result = QuizMathValidator._applyRate(text, result, steps);
    result = QuizMathValidator._applyPercentage(text, result, steps);
    result = QuizMathValidator._applyPostAddition(text, result, dataNumbers, steps); ? : agrega[rn] ? | añad[aeir] + | suma[rn] ? | adiciona[rn] ? | incorpora[rn] ? | más)\ s + ( ? : ( ? : un | una | el | la | un\ s + total\ s + de | una\ s + cantidad\ s + de)\ s + ) ? ( ? : \w + \s + ) { 0, 5 } ? ( ? : = \s * ) ? \$ ? \s * ([\d, ] + \. ? \d * ) / gi,
    result = QuizMathValidator._applyPostSubtraction(text, result, [...dataNumbers, ...subtractionNums], steps);

return steps.length > 0 ? { value: result, steps } : null;
}
l) {
    QuizMathValidator._parseDecimal(m[1]);
    // ═══ Strategy 4: Sum Fallback (GUARDED) ═══════════════════════════════al && val.gt(0)) {
    operations.push({
            static _trySumFallback(text) {
                apply: (v) => v.plus(val),
                const lower = text.toLowerCase();describe: (prev, result) => `Adición: ${prev} + ${val} = ${result}`,
                if (!/(?:total|suma|calcula|resultado|¿cuánto|cuántos|monto|costo|precio|valor)/i.test(lower)) return null;dex,

                const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
                const pctValues = QuizMathValidator._extractPercentages(text);

                const numRe = /\d[\d,]*\.?\d*/g;
                let nm;
                const candidates = [];
                while ((nm = numRe.exec(cleaned)) !== null) {
                    le\ s + ) ? ) ? ( ? : resta[rn] ? | quit[ao] ? [rn] ? | descuent[ao] ? [rn] ? | deduc[ei][rn] ? | sustrae[rn] ? | rebaj[ao] ? [rn] ? | menos)\ s + ( ? : ( ? : un | una | el | la | un\ s + total\ s + de | una\ s + cantidad\ s + de)\ s + ) ? ( ? : \w + \s + ) { 0, 5 } ? ( ? : = \s * ) ? \$ ? \s * ([\d, ] + \. ? \d * ) / gi,
            const val = QuizMathValidator._parseDecimal(nm[0]);
            if (!val) continue;
            if (pctValues.some(p => p.equals(val))) continue;
            if (val.lte(5)) continue;
            const n = val.toNumber();
            if (n >= 1900 && n <= 2100 && val.isInteger()) continue;
            candidates.push(val);ons.push({}
                apply: (v) => v.minus(val),
                if (candidates.length < 2) return null; describe: (prev, result) => `Sustracción: ${prev} - ${val} = ${result}`,
                position: m.index,
                const sorted = [...candidates].sort((a, b) => a.cmp(b));
            });
        const largest = sorted[sorted.length - 1];
        const dataNumbers = sorted.filter(n => n.gte(largest.times('0.001')) && n.gte(10));
        if (dataNumbers.length < 2) return null;

        const subtractionNums = QuizMathValidator._extractSubtractionNumbers(text);
        const additionNumbers = subtractionNums.length > 0 ?
            dataNumbers.filter(n => !subtractionNums.some(s => s.equals(n)))[\d, .] + ) / gi,: dataNumbers; + ) * ) ? ( ? : de\ s * ) ? \$ ? ([\d, .] + ) / gi,

    const steps = [];
let result;

if (/promedio|media\b/i.test(lower)) {
    const nums = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;
    actor = QuizMathValidator._parseDecimal(m[1]);
    const sum = nums.reduce((a, b) => a.plus(b), new Decimal(0));
    f(factor && factor.gt(0)) {
        result = sum.div(nums.length);
        operations.push({
                steps.push(`Suma: ${nums.join(' + ')} = ${sum}`);apply: (v) => v.times(factor),
                steps.push(`Promedio: ${sum} / ${nums.length} = ${result}`);: $ { prev }×
                $ { factor } = $ { result }
                `,
        } else {
            const nums = additionNumbers.length >= 2 ? additionNumbers : dataNumbers;                });
            result = nums.reduce((a, b) => a.plus(b), new Decimal(0));
            steps.push(`
                Suma: $ { nums.join(' + ') } = $ { result }
                `);   }
        }    }

        for (const subVal of subtractionNums) {    // Percentage patterns
            const prev = result;st pctMatch = /(?:impuesto|descuento|incremento|aumento|IVA)\s+(?:del?)?\s*([\d,.]+)\s*%/i.exec(text);
            result = result.minus(subVal);
            steps.push(`
                Resta: $ { prev } - $ { subVal } = $ { result }
                `);
        }

        if (pctValues.length > 0) {     const factor = isDiscount ?
            const pct = pctValues[0];100)) :
            if (pct.gt(0) && pct.lte(200)) {
                const prev = result;            operations.push({
                if (/descuento/i.test(lower)) {
                    const factor = new Decimal(1).minus(pct.div(100));emento'} ${pct}%: ${prev} × ${factor} = ${result}`,
                result = result.times(factor);position: pctMatch.index,
                steps.push(`Descuento ${pct}%: ${prev} × ${factor} = ${result}`);
            }
            else if (/impuesto|iva|incremento|aumento|interés|recargo/i.test(lower)) {
                const factor = new Decimal(1).plus(pct.div(100));
                result = result.times(factor);
                steps.push(`+ ${pct}%: ${prev} × ${factor} = ${result}`);
            }
        }
    }
    return operations;

    result = QuizMathValidator._applyRate(text, result, steps);
    result = QuizMathValidator._applyPostAddition(text, result, candidates, steps);────────────────────────────
    result = QuizMathValidator._applyPostSubtraction(text, result, [...candidates, ...subtractionNums], steps);

    return steps.length > 0 ? { value: result, steps } : null;
}
computing arithmetic directly, (2) labeled results,
rminal "= X" in chains.Catches cases where the question
    // ═══ Shared Helpers ═══════════════════════════════════════════════════ * text can't be parsed but the explanation has step-by-step math.

static _parseDecimal(str) {
    nation) {
    if (!str) return null;
    ') return null;
    try {
        const d = new Decimal(String(str).replace(/,/g, ''));
        ion text
        return d.isFinite() ? d : null;
        c(explanation);
    } catch { return null; }
}
rategy 2: Labeled result patterns(highest confidence)
const labelPatterns = [
    static _applyDecimals(value, text) {
        const match = text.match(/redonde[ao].*?(\d+)\s*decimal/i) / ( ? : el\ s + ) ? total\ s + ( ? : final\ s + ) ? ( ? : es |= |: )\ s * \$ ? \s * ([\d, ] + \. ? \d * ) / i,
            ||
            text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i);
        s * ([\d, ] + \. ? \d * ) / i,
            if (match) return value.toDecimalPlaces(parseInt(match[1]));

        if (/redonde[ao]\s+a\s+entero/i.test(text)) {
            return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
        }
        tterns) {

        return value;
        if (rm) {}
        seDecimal(rm[1]);
        if (d && d.gt(0)) { labeledResult = d; break; }
        static _extractPercentages(text) {}
        const pctRe = /([\d,.]+)\s*%/g;
        const result = [];
        let m;
        while ((m = pctRe.exec(text)) !== null) {
            st equalResults = [];
            const d = QuizMathValidator._parseDecimal(m[1]);
            /g;
            if (d) result.push(d);
        }
        return result;
        onst d = QuizMathValidator._parseDecimal(m[1]);
    }
    if (d && d.gt(0)) equalResults.push(d);

    static _extractSubtractionNumbers(text) {
        const results = [];
        const lastEquals = equalResults.length > 0 ? equalResults[equalResults.length - 1] : null;
        const patterns = [
            /(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?)\s+(?:(?:un|una|el|la|los|las|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi, X " /
            ( ? : menos | descontando | deduciendo)\ s + \$ ? \s * ([\d, ] + \. ? \d * ) / gi, null) || labeledResult || lastEquals;
    ];;

    for (const re of patterns) {
        let m;
        e
    }
    `];
            while ((m = re.exec(text)) !== null) {
                const d = QuizMathValidator._parseDecimal(m[1]);;
                if (d && d.gt(0) && !results.some(r => r.equals(d))) {
                    results.push(d);
                }
            }the closest option to a given numeric value.
        } * Returns { index, diff, within } where within=true if diff ≤ tolerance.
        return results;
    }estOption(options, value) {
) || options.length === 0) {
    static _extractDataNumbers(text) {ff: new Decimal(Infinity), within: false };
        const dataNumbers = [];
        let m;
et closestIdx = -1;
        const labeledPat = /(?:[a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ\s]*[:=]\s*\$?)([\d,]+\.?\d*)/gi;    let closestDiff = new Decimal(Infinity);
        while ((m = labeledPat.exec(text)) !== null) {
            const d = QuizMathValidator._parseDecimal(m[1]);    for (let i = 0; i < options.length; i++) {
            if (d && d.gte(10)) dataNumbers.push(d); const clean = String(options[i]).replace(/,/g, '');
        }

        if (dataNumbers.length < 2) {._parseDecimal(n)).filter(Boolean);
            dataNumbers.length = 0;
            const currencyPat = /\$\s?([\d,]+\.?\d*)/gi;  const optVal = parsed.reduce((a, b) => a.abs().gt(b.abs()) ? a : b);
            while ((m = currencyPat.exec(text)) !== null) {
                const d = QuizMathValidator._parseDecimal(m[1]);
                if (d && d.gte(1)) dataNumbers.push(d);      closestDiff = diff;
            }
        }

        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;01'), '0.01');
            const dePat = /(?:de|por|con|=)\s*\$?\s*([\d,]+\.?\d*)/gi;
            while ((m = dePat.exec(text)) !== null) {        index: closestIdx,
                const d = QuizMathValidator._parseDecimal(m[1]);
                if (d && d.gte(10)) dataNumbers.push(d);
            }
        }

        if (dataNumbers.length < 2) {// ── Ordering question fix: shuffle server-side & recompute correctOrder ───
            dataNumbers.length = 0;
            const stripped = text.replace(/[$€¥£₡₿]\s*/g, '');
            const allNums = stripped.match(/\d[\d,]*\.?\d*/g) || [];
            const pctSet = new Set(QuizMathValidator._extractPercentages(text).map(d => d.toString())); * 1. Reconstructs the correct sequence from LLM-provided items + correctOrder
            for (const raw of allNums) {
                const d = QuizMathValidator._parseDecimal(raw);
                if (!d || d.lt(10)) continue;
                if (pctSet.has(d.toString())) continue;
                const n = d.toNumber();
                if (n >= 1900 && n <= 2100 && d.isInteger()) continue;
                dataNumbers.push(d); * @param {string[]} items       - Items as provided by the LLM
            } provided by the LLM (may be wrong)
        }r[] }}

        return dataNumbers;
    }    const n = items.length;

    static _applyRate(text, result, steps) {
        const ratePatterns = [ &&
            /costo\s+(?:de\s+(?:procesamiento|producción|envío|operación|mantenimiento))?\s*(?:de|es|por|=)?\s*\$?([\d,.]+)/i,
            /precio\s+(?:de|por|unitario|cada)?\s*\$?([\d,.]+)/i,awCorrectOrder.every(i => Number.isInteger(i) && i >= 0 && i < n) &&
            /cada\s+\w+\s+(?:tiene\s+)?(?:un\s+)?(?:costo|precio|valor)\s+(?:de\s*)?\$?([\d,.]+)/i,        new Set(rawCorrectOrder).size === n;
            /(?:multiplic[aá]r?|×)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /(?:tasa|tarifa|factor|coeficiente)\s+(?:de\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i, items are already in correct order
            /\$\s*([\d,.]+)\s*(?:por|\/)\s*(?:cada|unidad|GB|kg|litro|km|hora)/i,
        ];e the last step.
        for (const re of ratePatterns) {
            const rm = text.match(re);d there is no decimal-alignment item near the first position,
            if (rm) {    // move it to position 0 (correct pedagogy: align decimal FIRST).
                const rate = QuizMathValidator._parseDecimal(rm[1]);r?|marcar?|alinear?)\b.{0,60}\b(coma|punto)\s*decimal\b|\balinear?\b.{0,40}\b(coma|punto)\s*decimal\b/i;
                if (rate && rate.gt(0) && rate.lt(result)) {rtical/i;
                    const prev = result;
                    result = result.times(rate); lastItem = correctSequence[n - 1] ? ? '';
                    steps.push(`
    Costo / Multiplicación: $ { prev }×
    $ { rate } = $ { result }
    `);    const firstItem = correctSequence[0] ? ? '';
                    break;TEP_RE.test(lastItem);
                }YWORDS.test(firstItem);
            }
        }
        return result; first. Item: "${lastItem.substring(0, 60)}"`);
}
op();

static _applyPercentage(text, result, steps) {
    const pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA|ISR|interés)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
    if (!pctMatch) return result; // Step 2: Fisher-Yates shuffle on index mapping
    s]
const pct = QuizMathValidator._parseDecimal(pctMatch[1]);
onst shuffleMap = Array.from({ length: n }, (_, i) => i);
if (!pct || pct.lte(0) || pct.gt(200)) return result;
for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const prev = result;
    if (/descuento/i.test(pctMatch[0])) {
        const factor = new Decimal(1).minus(pct.div(100));
        result = result.times(factor);
        Ensure at least one position changed(question isn 't trivial)
            steps.push(`Descuento ${pct}%: ${prev} × ${factor} = ${result}`);
        }
        else {
            const factor = new Decimal(1).plus(pct.div(100));
            result = result.times(factor);
            steps.push(`+ ${pct}%: ${prev} × ${factor} = ${result}`);
        }
        ectSequence[origPos]);
    return result;
}

static _applyPostSubtraction(text, result, excludeNumbers, steps) {
    const subMatch = text.match(/(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?)\s+(?:(?:un|una|el|la|los|las|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/i);
    (let newPos = 0; newPos < n; newPos++) {
        if (!subMatch) return result;

        const subVal = QuizMathValidator._parseDecimal(subMatch[1]);
        if (!subVal || subVal.lte(0)) return result;
        return { items: shuffledItems, correctOrder: newCorrectOrder, correctSequence };

        const isDuplicate = excludeNumbers.some(n =>
            (n instanceof Decimal ? n.equals(subVal) : new Decimal(n).equals(subVal))
        );
        tion
        for an ordering question that is guaranteed
        if (isDuplicate) return result;
        OF TRUTH— the explanation
        correct sequence, never from the LLM text.
        const prev = result;
        result = result.minus(subVal);
        (arrow chains,
            steps.push(`Sustracción: ${prev} - ${subVal} = ${result}`);, ordinal sequences) that could contradict the programmatic
        return result;
        ual / educational reasoning is preserved.
    }
    tches explanation text that mentions a wrong step / phase count
    static _applyPostAddition(text, result, excludeNumbers, steps) { * (e.g.
            "4 fases"
            when there are actually 5 items).
        const addMatch = text.match(/(?:se\s+)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (!addMatch) return result;
        eir correct order
        Explanation - Original LLM explanation(may contain conflicting order)
        const addVal = QuizMathValidator._parseDecimal(addMatch[1]);
        onical explanation with single source of truth
        if (!addVal || addVal.lte(0)) return result;
        ce, llmExplanation = '') {
        const isDuplicate = excludeNumbers.some(n => onst n = correctSequence.length;
            (n instanceof Decimal ? n.equals(addVal) : new Decimal(n).equals(addVal)) let sanitized = QuizMathValidator._stripOrderingClaims(llmExplanation);
        );
        if (isDuplicate) return result;
        en n = 5)

    const prev = result;
    /\b(\d+)\s+(paso[s]?|fase[s]?|etapa[s]?|step[s]?)\b/gi,
    result = result.plus(addVal);
    steps.push(`Adición: ${prev} + ${addVal} = ${result}`);
    return result;
}
console.warn(`[OrderingExplanation] Patched wrong step count: ${mentioned} → ${n}`);
/^\d+\s+/, '')
}
`;
    static _detectFollowUpOperations(text) {      }
        if (!text) return [];

        const operations = [];

        const addPatterns = [
            /(?:y\s+)?(?:se\s+(?:le\s+)?)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?|más)\s+(?:(?:un|una|el|la|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi,        .map((item, i) => `
$ { i + 1 }.$ { item }
`)
        ];
        for (const re of addPatterns) {    return sanitized ?
            let m;ed}` :
while ((m = re.exec(text)) !== null) {
    const val = QuizMathValidator._parseDecimal(m[1]);
}
if (val && val.gt(0)) {
    operations.push({
        apply: (v) => v.plus(val),
        describe: (prev, result) => `Adición: ${prev} + ${val} = ${result}`,
        * contradictions with the programmatically computed correct order.
        position: m.index,
    });
} * (first / second, primero / segundo), and explicit "the order is..."
phrases.
}
}

const subPatterns = [ *
    /(?:se\s+(?:le\s+)?)?(?:resta[rn]?|quit[ao]?[rn]?|descuent[ao]?[rn]?|deduc[ei][rn]?|sustrae[rn]?|rebaj[ao]?[rn]?|menos)\s+(?:(?:un|una|el|la|un\s+total\s+de|una\s+cantidad\s+de)\s+)?(?:\w+\s+){0,5}?(?:=\s*)?\$?\s*([\d,]+\.?\d*)/gi,
];
for (const re of subPatterns) {
    let m;
    static _stripOrderingClaims(text) {
        while ((m = re.exec(text)) !== null) {
            const val = QuizMathValidator._parseDecimal(m[1]);
            if (val && val.gt(0)) {
                operations.push({
                    apply: (v) => v.minus(val),
                    arrow - chain sequences: "A → B → C → D" (≥3 elements)
                    describe: (prev, result) => `Sustracción: ${prev} - ${val} = ${result}`,
                    = s.replace(/[\w\sáéíóúñÁÉÍÓÚÑ]+(?:\s*[→⟶⟹⇒]+\s*[\w\sáéíóúñÁÉÍÓÚÑ]+){2,}/g, '');
                    position: m.index,
                }); // 2. Remove explicit "the order is/correct order is" phrases (EN + ES)
            }
            correct\ s + | logical\ s + ) ? order\ s + ( ? : is | would\ s + be | should\ s + be)\ s *: ? [ ^ .;] * /gi, '');
















































































































































































































        export default QuizMathValidator;
    }
}
return s;
s = s.replace(/^[.,;:\s]+/, '').replace(/[,;:\s]+$/, '').trim();
s = s.replace(/[,:;]\s*[,:;]/g, ',').replace(/\.(\s*\.)+/g, '.').replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
s = s.replace(/(?:de\s+(?:lo\s+)?[\wáéíóúñ]+\s+a\s+(?:lo\s+)?[\wáéíóúñ]+(?:\s+a\s+(?:lo\s+)?[\wáéíóúñ]+)+)/gi, '');
s = s.replace(/(?:from\s+.+?\s+to\s+.+?(?:\s+to\s+.+?)+)/gi, '');
s = s.replace(ordinalPattern, '');
const ordinalPattern = /(?:(?:first|second|third|fourth|fifth|sixth|primero|segundo|tercero|cuarto|quinto|sexto)\s*[:,.]\s*[^,;.]+[,;.]\s*){2,}/gi;
s = s.replace(/(?:^|\n)\s*\d+[.)]\s+.+(?:\n\s*\d+[.)]\s+.+){2,}/gm, '');
s = s.replace(/(?:el\s+)?orden\s+(?:correcto\s+|l[oó]gico\s+)?(?:es|ser[ií]a|debe\s+ser)\s*:?[^.;]*/gi, '');
s = s.replace(/(?:the\s+)?(?:correct\s+|logical\s+)?order\s+(?:is|would\s+be|should\s+be)\s*:?[^.;]*/gi, '');
s = s.replace(/[\w\sáéíóúñÁÉÍÓÚÑ]+(?:\s*[→⟶⟹⇒]+\s*[\w\sáéíóúñÁÉÍÓÚÑ]+){2,}/g, '');
let s = text;
if (!text || typeof text !== 'string') return '';
static _stripOrderingClaims(text) {}: `Orden correcto:\n${numbered}`; ? `${sanitized.replace(/\.\s*$/, '')}.\n\nOrden correcto:\n${numbered}`
return sanitized.join('\n');.map((item, i) => `${i + 1}. ${item}`) const numbered = correctSequence);
}
return match;
if (mentioned !== n) return `${n} ${match.replace(/^\d+\s+/, '')}`;
const mentioned = parseInt(num, 10);
(match, num) => {
    /\b(\d+)\s+(paso[s]?|fase[s]?|etapa[s]?|step[s]?)\b/gi,
    sanitized = sanitized.replace(let sanitized = QuizMathValidator._stripOrderingClaims(llmExplanation);
        const n = correctSequence.length; static buildOrderingExplanation(correctSequence, llmExplanation = '') {}
        return { items: shuffledItems, correctOrder: newCorrectOrder, correctSequence };
    }
    newCorrectOrder[shuffleMap[newPos]] = newPos;
    for (let newPos = 0; newPos < n; newPos++) { const newCorrectOrder = new Array(n); const shuffledItems = shuffleMap.map(origPos => correctSequence[origPos]); }[shuffleMap[0], shuffleMap[1]] = [shuffleMap[1], shuffleMap[0]];
    if (shuffleMap.every((v, i) => v === i)) {}[shuffleMap[i], shuffleMap[j]] = [shuffleMap[j], shuffleMap[i]];
    const j = Math.floor(Math.random() * (i + 1));
    for (let i = n - 1; i > 0; i--) { const shuffleMap = Array.from({ length: n }, (_, i) => i); }
    correctSequence.unshift(decimalItem);
    const decimalItem = correctSequence.pop();
    if (isLastDecimalStep && !firstAlreadyAligns && n >= 3) {
        const firstAlreadyAligns = DECIMAL_STEP_RE.test(firstItem) || DECIMAL_ALIGN_KEYWORDS.test(firstItem);
        const isLastDecimalStep = DECIMAL_STEP_RE.test(lastItem);
        const firstItem = correctSequence[0] ? ? '';
        const lastItem = correctSequence[n - 1] ? ? '';
        const DECIMAL_ALIGN_KEYWORDS = /alinea[rn]?|vertical/i;
        const DECIMAL_STEP_RE = /\b(coloc[ae]r?|baj[ae]r?|pon[ae]r?|ubic[ae]r?|marcar?|alinear?)\b.{0,60}\b(coma|punto)\s*decimal\b|\balinear?\b.{0,40}\b(coma|punto)\s*decimal\b/i;: [...items]; ? rawCorrectOrder.map(i => items[i]) let correctSequence = isValidPerm && new Set(rawCorrectOrder).size === n; && rawCorrectOrder.every(i => Number.isInteger(i) && i >= 0 && i < n) && rawCorrectOrder.length === n
        const isValidPerm = Array.isArray(rawCorrectOrder) const n = items.length;
        static fixOrderingQuestion(items, rawCorrectOrder) { // ═══ Ordering Helpers ═════════════════════════════════════════════════    }        };            within: closestIdx >= 0 && closestDiff.lte(tolerance),            diff: closestDiff,            index: closestIdx,        return {        const tolerance = Decimal.max(value.abs().times('0.001'), '0.01');        }            }                closestIdx = i;                closestDiff = diff;            if (diff.lt(closestDiff)) {            const diff = optVal.minus(value).abs();            const optVal = parsed.reduce((a, b) => a.abs().gt(b.abs()) ? a : b);            if (parsed.length === 0) continue;            const parsed = nums.map(n => QuizMathValidator._parseDecimal(n)).filter(Boolean);            if (!nums) continue;            const nums = clean.match(/\d+\.?\d*/g);            const clean = String(options[i]).replace(/,/g, '');        for (let i = 0; i < options.length; i++) {        let closestDiff = new Decimal(Infinity);        let closestIdx = -1;        }            return { index: -1, diff: new Decimal(Infinity), within: false };        if (!Array.isArray(options) || options.length === 0) {    static _findClosestOption(options, value) {    }        return { value: finalValue, steps };            : [`[Verificado desde explicación] Resultado: ${finalValue}`];            ? computed.steps        const steps = computed        if (!finalValue) return null;        const finalValue = (computed ? computed.value : null) || labeledResult || lastEquals;        const lastEquals = equalResults.length > 0 ? equalResults[equalResults.length - 1] : null;        }            if (d && d.gt(0)) equalResults.push(d);            const d = QuizMathValidator._parseDecimal(m[1]);        while ((m = eqPattern.exec(explanation)) !== null) {        let m;        const eqPattern = /=\s*\$?\s*([\d,]+\.?\d*)/g;        const equalResults = [];        }            }                if (d && d.gt(0)) { labeledResult = d; break; }                const d = QuizMathValidator._parseDecimal(rm[1]);            if (rm) {            const rm = explanation.match(re);        for (const re of labelPatterns) {        let labeledResult = null;        ];            /(?:respuesta|solución)\s+(?:correcta\s+)?(?:es|=|:)\s*\$?\s*([\d,]+\.?\d*)/i,            /(?:the\s+)?(?:final\s+)?(?:answer|result)\s+(?:is|=|:)\s*\$?\s*([\d,]+\.?\d*)/i,            /(?:el\s+)?total\s+(?:final\s+)?(?:es|=|:)\s*\$?\s*([\d,]+\.?\d*)/i,            /resultado\s+(?:final\s*)?(?:es|=|:)\s*\$?\s*([\d,]+\.?\d*)/i,        const labelPatterns = [        const computed = QuizMathValidator._tryExplicitArithmetic(explanation);        if (!explanation || typeof explanation !== 'string') return null;    static _tryFromExplanation(explanation) {    // ═══ Explanation Cross-Validation ══════════════════════════════════════    }        return operations;        operations.sort((a, b) => a.position - b.position);        }            }                });                    position: pctMatch.index,                    describe: (prev, result) => `${isDiscount ? 'Descuento' : 'Incremento'} ${pct}%: ${prev} × ${factor} = ${result}`,                    apply: (v) => v.times(factor),                operations.push({                    : new Decimal(1).plus(pct.div(100));                    ? new Decimal(1).minus(pct.div(100))                const factor = isDiscount                const isDiscount = /descuento/i.test(pctMatch[0]);            if (pct && pct.gt(0)) {            const pct = QuizMathValidator._parseDecimal(pctMatch[1]);        if (pctMatch) {        const pctMatch = /(?:impuesto|descuento|incremento|aumento|IVA)\s+(?:del?)?\s*([\d,.]+)\s*%/i.exec(text);        }            }                }                    });                        position: m.index,                        describe: (prev, result) => `Multiplicación: ${prev} × ${factor} = ${result}`,                        apply: (v) => v.times(factor),                    operations.push({                if (factor && factor.gt(0)) {                const factor = QuizMathValidator._parseDecimal(m[1]);            if (m) {            const m = re.exec(text);        for (const re of multPatterns) {        ];            /cada\s+\w+\s+.*?\$?([\d,.]+)/gi,            /(?:costo|precio|tarifa|tasa)\s+(?:de\s+(?:\w+\s+)*)?(?:de\s*)?\$?([\d,.]+)/gi,            /(?:multiplic[aá]r?\s+por|×)\s*\$?([\d,.]+)/gi,        const multPatterns = [        }            }    s = s.replace(/(?:el\s+)?orden\s+(?:correcto\s+|l[oó]gico\s+)?(?:es|ser[ií]a|debe\s+ser)\s*:?[^.;]*/gi, '');

            // 3. Remove numbered step enumerations: "1. X\n2. Y\n3. Z" (≥3 consecutive)
            s = s.replace(/(?:^|\n)\s*\d+[.)]\s+.+(?:\n\s*\d+[.)]\s+.+){2,}/gm, '');

            // 4. Remove ordinal enumeration sequences (EN: first...second...third; ES: primero...segundo...tercero)
            const ordinalPattern = /(?:(?:first|second|third|fourth|fifth|sixth|primero|segundo|tercero|cuarto|quinto|sexto)\s*[:,.]\s*[^,;.]+[,;.]\s*){2,}/gi;
            s = s.replace(ordinalPattern, '');

            // 5. Remove stray "from X to Y to Z" / "de X a Y a Z" ordering descriptions
            s = s.replace(/(?:from\s+.+?\s+to\s+.+?(?:\s+to\s+.+?)+)/gi, '');
            s = s.replace(/(?:de\s+(?:lo\s+)?[\wáéíóúñ]+\s+a\s+(?:lo\s+)?[\wáéíóúñ]+(?:\s+a\s+(?:lo\s+)?[\wáéíóúñ]+)+)/gi, '');

            // Clean up residual whitespace and punctuation artifacts
            s = s.replace(/[,:;]\s*[,:;]/g, ',').replace(/\.(\s*\.)+/g, '.').replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
            s = s.replace(/^[.,;:\s]+/, '').replace(/[,;:\s]+$/, '').trim();

            return s;
        }
    }

    export default QuizMathValidator;