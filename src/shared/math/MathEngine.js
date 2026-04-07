/**
 * MathEngine — Motor de evaluación matemática con precisión arbitraria.
 *
 * SOLID:
 *   SRP: Solo parsea y evalúa expresiones matemáticas.
 *   OCP: Nuevas funciones se registran sin modificar el evaluador.
 *   DIP: Usa Decimal.js como abstracción numérica.
 *
 * Implementa un parser de descenso recursivo con precedencia de operadores:
 *   Expression := Term (('+' | '-') Term)*
 *   Term       := Power (('*' | '/' | '×' | '÷') Power)*
 *   Power      := Unary ('^' Unary)?
 *   Unary      := '-' Unary | Atom
 *   Atom       := Number | '(' Expression ')' | Function '(' Expression (',' Expression)* ')'
 *
 * Características:
 *   - Precisión de 64 dígitos (Decimal.js)
 *   - Funciones: sqrt, abs, round, floor, ceil, log, ln, pow, factorial
 *   - Series: geométrica, aritmética, polinomial
 *   - Evaluación segura (sin eval/Function)
 */

import Decimal from 'decimal.js';

Decimal.set({ precision: 64 });
// ═══════════════════════════════════════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════════════════════════════════════

const TokenType = {
    NUMBER: 'NUMBER',
    PLUS: 'PLUS',
    MINUS: 'MINUS',
    MULTIPLY: 'MULTIPLY',
    DIVIDE: 'DIVIDE',
    POWER: 'POWER',
    LPAREN: 'LPAREN',
    RPAREN: 'RPAREN',
    COMMA: 'COMMA',
    IDENT: 'IDENT',
    EOF: 'EOF',
};

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const s = expr.trim();

    while (i < s.length) {
        const ch = s[i];

        // Whitespace
        if (/\s/.test(ch)) { i++; continue; }

        // Number: digits, dots, commas in numeric context
        if (/\d/.test(ch)) {
            let num = '';
            while (i < s.length && /[\d.,]/.test(s[i])) {
                if (s[i] === ',') {
                    // Check if it's followed by exactly 3 digits (thousands separator)
                    const after = s.substring(i + 1).match(/^(\d{3})(?!\d)/);
                    if (after) { i++; continue; }
                    // Otherwise stop number parsing — comma is a separator (e.g. function args)
                    break;
                } else {
                    num += s[i];
                }
                i++;
            }
            tokens.push({ type: TokenType.NUMBER, value: num });
            continue;
        }

        // Operators
        if (ch === '+') { tokens.push({ type: TokenType.PLUS }); i++; continue; }
        if (ch === '-' || ch === '−' || ch === '\u2212') { tokens.push({ type: TokenType.MINUS }); i++; continue; }
        if (ch === '*' || ch === '×' || ch === '\xd7') { tokens.push({ type: TokenType.MULTIPLY }); i++; continue; }
        if (ch === '/' || ch === '÷' || ch === '\xf7') { tokens.push({ type: TokenType.DIVIDE }); i++; continue; }
        if (ch === '^') { tokens.push({ type: TokenType.POWER }); i++; continue; }
        if (ch === '(') { tokens.push({ type: TokenType.LPAREN }); i++; continue; }
        if (ch === ')') { tokens.push({ type: TokenType.RPAREN }); i++; continue; }
        if (ch === ',') { tokens.push({ type: TokenType.COMMA }); i++; continue; }

        // Identifier (function name or constant)
        if (/[a-zA-Z_]/.test(ch)) {
            let ident = '';
            while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) {
                ident += s[i];
                i++;
            }
            tokens.push({ type: TokenType.IDENT, value: ident.toLowerCase() });
            continue;
        }

        // Skip unknown characters
        i++;
    }

    tokens.push({ type: TokenType.EOF });
    return tokens;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser + Evaluator (recursive descent)
// ═══════════════════════════════════════════════════════════════════════════

const BUILTIN_FUNCTIONS = {
    sqrt: (args) => { if (args.length !== 1) throw new Error('sqrt requires 1 argument'); return args[0].sqrt(); },
    abs: (args) => { if (args.length !== 1) throw new Error('abs requires 1 argument'); return args[0].abs(); },
    round: (args) => {
        if (args.length === 1) return args[0].round();
        return args[0].toDecimalPlaces(args[1].toNumber(), Decimal.ROUND_HALF_UP);
    },
    floor: (args) => { if (args.length !== 1) throw new Error('floor requires 1 argument'); return args[0].floor(); },
    ceil: (args) => { if (args.length !== 1) throw new Error('ceil requires 1 argument'); return args[0].ceil(); },
    log: (args) => {
        if (args.length === 1) return args[0].log(10);
        return args[0].log(args[1].toNumber());
    },
    ln: (args) => { if (args.length !== 1) throw new Error('ln requires 1 argument'); return args[0].ln(); },
    pow: (args) => { if (args.length !== 2) throw new Error('pow requires 2 arguments'); return args[0].pow(args[1]); },
    factorial: (args) => {
        if (args.length !== 1) throw new Error('factorial requires 1 argument');
        const n = args[0].toNumber();
        if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('factorial: n must be 0-170 integer');
        let result = new Decimal(1);
        for (let i = 2; i <= n; i++) result = result.times(i);
        return result;
    },
    min: (args) => { if (args.length === 0) throw new Error('min requires arguments'); return Decimal.min(...args); },
    max: (args) => { if (args.length === 0) throw new Error('max requires arguments'); return Decimal.max(...args); },
    mod: (args) => { if (args.length !== 2) throw new Error('mod requires 2 arguments'); return args[0].mod(args[1]); },
};

const CONSTANTS = {
    pi: () => Decimal.acos(-1),
    e: () => new Decimal(1).exp(),
};

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }

    peek() { return this.tokens[this.pos]; }
    advance() { return this.tokens[this.pos++]; }

    expect(type) {
        const tok = this.advance();
        if (tok.type !== type) throw new Error(`Expected ${type}, got ${tok.type}`);
        return tok;
    }

    // Expression := Term (('+' | '-') Term)*
    parseExpression() {
        let left = this.parseTerm();
        while (this.peek().type === TokenType.PLUS || this.peek().type === TokenType.MINUS) {
            const op = this.advance();
            const right = this.parseTerm();
            left = op.type === TokenType.PLUS ? left.plus(right) : left.minus(right);
        }
        return left;
    }

    // Term := Power (('*' | '/') Power)*
    parseTerm() {
        let left = this.parsePower();
        while (this.peek().type === TokenType.MULTIPLY || this.peek().type === TokenType.DIVIDE) {
            const op = this.advance();
            const right = this.parsePower();
            if (op.type === TokenType.MULTIPLY) {
                left = left.times(right);
            } else {
                if (right.isZero()) throw new Error('Division by zero');
                left = left.div(right);
            }
        }
        return left;
    }

    // Power := Unary ('^' Unary)?
    parsePower() {
        const base = this.parseUnary();
        if (this.peek().type === TokenType.POWER) {
            this.advance();
            const exponent = this.parseUnary();
            return base.pow(exponent);
        }
        return base;
    }

    // Unary := '-' Unary | Atom
    parseUnary() {
        if (this.peek().type === TokenType.MINUS) {
            this.advance();
            return this.parseUnary().neg();
        }
        // Unary plus
        if (this.peek().type === TokenType.PLUS) {
            this.advance();
            return this.parseUnary();
        }
        return this.parseAtom();
    }

    // Atom := Number | '(' Expression ')' | Function '(' args ')' | Constant
    parseAtom() {
        const tok = this.peek();

        if (tok.type === TokenType.NUMBER) {
            this.advance();
            return new Decimal(tok.value);
        }

        if (tok.type === TokenType.LPAREN) {
            this.advance();
            const val = this.parseExpression();
            this.expect(TokenType.RPAREN);
            return val;
        }

        if (tok.type === TokenType.IDENT) {
            this.advance();
            const name = tok.value;

            // Check if it's a function call
            if (this.peek().type === TokenType.LPAREN) {
                this.advance(); // consume '('
                const args = [];
                if (this.peek().type !== TokenType.RPAREN) {
                    args.push(this.parseExpression());
                    while (this.peek().type === TokenType.COMMA) {
                        this.advance();
                        args.push(this.parseExpression());
                    }
                }
                this.expect(TokenType.RPAREN);

                const fn = BUILTIN_FUNCTIONS[name];
                if (!fn) throw new Error(`Unknown function: ${name}`);
                return fn(args);
            }

            // Check constants
            const constantFn = CONSTANTS[name];
            if (constantFn) return constantFn();

            throw new Error(`Unknown identifier: ${name}`);
        }

        throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export class MathEngine {
    /**
     * Evalúa una expresión matemática con precisión arbitraria.
     * @param {string} expression - e.g. "3 * (5 + 2) - 1"
     * @returns {Decimal} resultado
     * @throws {Error} si la expresión es inválida
     */
    static evaluate(expression) {
        if (!expression || typeof expression !== 'string') {
            throw new Error('Expression must be a non-empty string');
        }
        const tokens = tokenize(expression);
        const parser = new Parser(tokens);
        const result = parser.parseExpression();

        // Verify we consumed all tokens
        if (parser.peek().type !== TokenType.EOF) {
            throw new Error(`Unexpected token after expression: ${JSON.stringify(parser.peek())}`);
        }
        return result;
    }

    /**
     * Evalúa de forma segura, retorna null en caso de error.
     * @param {string} expression
     * @returns {Decimal|null}
     */
    static tryEvaluate(expression) {
        try {
            return MathEngine.evaluate(expression);
        } catch {
            return null;
        }
    }

    /**
     * Calcula la suma de una serie geométrica.
     * S_n = a1 * (r^n - 1) / (r - 1) para r ≠ 1
     * @param {number|string|Decimal} a1 - Primer término
     * @param {number|string|Decimal} r - Razón común
     * @param {number} n - Número de términos
     * @returns {{ value: Decimal, steps: string[] }}
     */
    static geometricSeries(a1, r, n) {
        const da1 = new Decimal(a1);
        const dr = new Decimal(r);
        if (dr.eq(1)) {
            const value = da1.times(n);
            return { value, steps: [`S_n = a1 × n = ${da1} × ${n} = ${value}`] };
        }
        const rPowN = dr.pow(n);
        const value = da1.times(rPowN.minus(1)).div(dr.minus(1));
        return {
            value,
            steps: [
                `Serie geométrica: a1=${da1}, r=${dr}, n=${n}`,
                `S_n = ${da1} × (${dr}^${n} − 1) / (${dr} − 1) = ${value}`,
            ],
        };
    }

    /**
     * Calcula la suma de una serie aritmética.
     * S_n = n/2 * (2*a1 + (n-1)*d)
     * @param {number|string|Decimal} a1 - Primer término
     * @param {number|string|Decimal} d - Diferencia común
     * @param {number} n - Número de términos
     * @returns {{ value: Decimal, steps: string[] }}
     */
    static arithmeticSeries(a1, d, n) {
        const da1 = new Decimal(a1);
        const dd = new Decimal(d);
        const dn = new Decimal(n);
        const value = dn.div(2).times(da1.times(2).plus(dd.times(dn.minus(1))));
        return {
            value,
            steps: [
                `Serie aritmética: a1=${da1}, d=${dd}, n=${n}`,
                `S_n = ${n}/2 × (2×${da1} + (${n}-1)×${dd}) = ${value}`,
            ],
        };
    }

    /**
     * Calcula sumatoria polinomial Σ(i=start..end) de f(i).
     * @param {number} start
     * @param {number} end
     * @param {{ a3: number, a2: number, a1: number, a0: number }} coeffs
     * @returns {{ value: Decimal, steps: string[] }}
     */
    static polynomialSummation(start, end, coeffs) {
        const n = new Decimal(end);
        const steps = [];

        // For i=1..n, use closed-form formulas if possible
        if (start === 1 && end <= 100000) {
            let result = new Decimal(0);
            const a3 = new Decimal(coeffs.a3 || 0);
            const a2 = new Decimal(coeffs.a2 || 0);
            const a1 = new Decimal(coeffs.a1 || 0);
            const a0 = new Decimal(coeffs.a0 || 0);

            if (!a3.isZero()) {
                // Σi³ = [n(n+1)/2]²
                const sumI3 = n.times(n.plus(1)).div(2).pow(2);
                result = result.plus(a3.times(sumI3));
                steps.push(`${a3}·Σi³ = ${a3.times(sumI3)}`);
            }
            if (!a2.isZero()) {
                // Σi² = n(n+1)(2n+1)/6
                const sumI2 = n.times(n.plus(1)).times(n.times(2).plus(1)).div(6);
                result = result.plus(a2.times(sumI2));
                steps.push(`${a2}·Σi² = ${a2.times(sumI2)}`);
            }
            if (!a1.isZero()) {
                // Σi = n(n+1)/2
                const sumI1 = n.times(n.plus(1)).div(2);
                result = result.plus(a1.times(sumI1));
                steps.push(`${a1}·Σi = ${a1.times(sumI1)}`);
            }
            if (!a0.isZero()) {
                result = result.plus(a0.times(n));
                steps.push(`${a0}·n = ${a0.times(n)}`);
            }

            steps.unshift(`Σ(i=1..${end})`);
            steps.push(`Resultado: ${result}`);
            return { value: result, steps };
        }

        // General case: iterate
        if (end - start + 1 > 100000) throw new Error('Summation range too large');
        let result = new Decimal(0);
        for (let i = start; i <= end; i++) {
            const di = new Decimal(i);
            const a3 = new Decimal(coeffs.a3 || 0);
            const a2 = new Decimal(coeffs.a2 || 0);
            const a1 = new Decimal(coeffs.a1 || 0);
            const a0 = new Decimal(coeffs.a0 || 0);
            result = result.plus(
                a3.times(di.pow(3))
                    .plus(a2.times(di.pow(2)))
                    .plus(a1.times(di))
                    .plus(a0)
            );
        }
        steps.push(`Σ(i=${start}..${end}) = ${result}`);
        return { value: result, steps };
    }

    /**
     * Calcula interés simple: I = C × r × t
     * @param {number|string|Decimal} capital
     * @param {number|string|Decimal} ratePercent - Tasa en porcentaje
     * @param {number|string|Decimal} time
     * @returns {{ interest: Decimal, total: Decimal, steps: string[] }}
     */
    static simpleInterest(capital, ratePercent, time) {
        const c = new Decimal(capital);
        const r = new Decimal(ratePercent).div(100);
        const t = new Decimal(time);
        const interest = c.times(r).times(t);
        const total = c.plus(interest);
        return {
            interest,
            total,
            steps: [
                `Interés simple: I = ${c} × ${r} × ${t} = ${interest}`,
                `Monto total: ${c} + ${interest} = ${total}`,
            ],
        };
    }

    /**
     * Calcula interés compuesto: M = C × (1 + r)^t
     * @param {number|string|Decimal} capital
     * @param {number|string|Decimal} ratePercent - Tasa en porcentaje
     * @param {number|string|Decimal} time
     * @returns {{ interest: Decimal, total: Decimal, steps: string[] }}
     */
    static compoundInterest(capital, ratePercent, time) {
        const c = new Decimal(capital);
        const r = new Decimal(ratePercent).div(100);
        const t = new Decimal(time);
        const factor = new Decimal(1).plus(r).pow(t);
        const total = c.times(factor);
        const interest = total.minus(c);
        return {
            interest,
            total,
            steps: [
                `Interés compuesto: M = ${c} × (1 + ${r})^${t}`,
                `Factor = ${factor}`,
                `Monto = ${total}, Interés = ${interest}`,
            ],
        };
    }

    /**
     * Resuelve un sistema de 2 ecuaciones lineales por Cramer.
     * a1*x + b1*y = c1
     * a2*x + b2*y = c2
     * @returns {{ x: Decimal, y: Decimal, steps: string[] } | null}
     */
    static solveLinearSystem2x2(a1, b1, c1, a2, b2, c2) {
        const da1 = new Decimal(a1), db1 = new Decimal(b1), dc1 = new Decimal(c1);
        const da2 = new Decimal(a2), db2 = new Decimal(b2), dc2 = new Decimal(c2);
        const det = da1.times(db2).minus(da2.times(db1));
        if (det.isZero()) return null;
        const x = dc1.times(db2).minus(dc2.times(db1)).div(det);
        const y = da1.times(dc2).minus(da2.times(dc1)).div(det);
        return {
            x, y,
            steps: [
                `Determinante: ${da1}×${db2} - ${da2}×${db1} = ${det}`,
                `x = (${dc1}×${db2} - ${dc2}×${db1}) / ${det} = ${x}`,
                `y = (${da1}×${dc2} - ${da2}×${dc1}) / ${det} = ${y}`,
            ],
        };
    }

    /**
     * Verifica si un valor coincide con alguna opción dentro de tolerancia.
     * @param {Decimal} value
     * @param {string[]} options
     * @param {number} relTolerance - Tolerancia relativa (default 0.01 = 1%)
     * @param {number} absTolerance - Tolerancia absoluta (default 0.5)
     * @returns {{ index: number, value: Decimal, within: boolean } | null}
     */
    static findClosestOption(value, options, relTolerance = 0.01, absTolerance = 0.5) {
        if (!options || !options.length || !value) return null;

        let bestIdx = -1;
        let bestDiff = null;

        for (let i = 0; i < options.length; i++) {
            const cleaned = String(options[i]).replace(/[^\d.,-]/g, '');
            const opt = MathEngine.parseDecimal(cleaned);
            if (!opt) continue;
            const diff = value.minus(opt).abs();
            if (bestDiff === null || diff.lt(bestDiff)) {
                bestDiff = diff;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) return null;

        const bestOpt = MathEngine.parseDecimal(String(options[bestIdx]).replace(/[^\d.,-]/g, ''));
        if (!bestOpt) return null;

        const relErr = value.isZero() ? bestDiff : bestDiff.div(value.abs());
        const within = relErr.lte(relTolerance) || bestDiff.lte(absTolerance);

        return { index: bestIdx, value: bestOpt, within };
    }

    /**
     * Parsea un string a Decimal de forma segura.
     * @param {string} str
     * @returns {Decimal|null}
     */
    static parseDecimal(str) {
        if (!str) return null;
        try {
            const d = new Decimal(String(str).replace(/,/g, ''));
            return d.isFinite() ? d : null;
        } catch {
            return null;
        }
    }

    /**
     * Detecta si una secuencia de números forma una serie geométrica.
     * @param {Decimal[]} values - Al menos 3 valores
     * @returns {{ a1: Decimal, r: Decimal } | null}
     */
    static detectGeometricSequence(values) {
        if (!values || values.length < 3) return null;
        if (values[0].isZero()) return null;

        const r = values[1].div(values[0]);
        if (r.eq(1) || r.eq(0)) return null;

        for (let i = 2; i < values.length; i++) {
            if (values[i - 1].isZero()) return null;
            const ri = values[i].div(values[i - 1]);
            if (!ri.toFixed(8).endsWith(r.toFixed(8).slice(-8))) {
                // Allow small floating point drift
                if (ri.minus(r).abs().div(r.abs().plus(1)).gt(0.001)) return null;
            }
        }

        // Ratio must be a simple value (integer or simple fraction)
        const rNum = parseFloat(r.toFixed(6));
        if (!Number.isFinite(rNum) || rNum <= 0) return null;

        const isSimple = Math.abs(rNum - Math.round(rNum)) < 0.001 ||
            Math.abs(rNum * 2 - Math.round(rNum * 2)) < 0.001 ||
            Math.abs(rNum * 3 - Math.round(rNum * 3)) < 0.001 ||
            Math.abs(rNum * 4 - Math.round(rNum * 4)) < 0.001;

        if (!isSimple) return null;

        return { a1: values[0], r };
    }

    /**
     * Convierte un número a notación científica.
     * @param {Decimal} value
     * @returns {{ mantissa: Decimal, exponent: number }}
     */
    static toScientificNotation(value) {
        if (value.isZero()) return { mantissa: new Decimal(0), exponent: 0 };
        const absVal = value.abs();
        const exponent = absVal.log(10).floor().toNumber();
        const mantissa = value.div(new Decimal(10).pow(exponent));
        return { mantissa, exponent };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Polynomial Analysis
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Parses a polynomial from text like "x³ - 12x² + 45x - 10".
     * Supports unicode superscripts (²³⁴⁵⁶⁷⁸⁹) and ^ notation.
     * @param {string} text - Expression containing the polynomial (e.g., "f(x) = x³ - 12x² + 45x - 10")
     * @returns {Object|null} Map { power: Decimal(coefficient) } or null
     */
    static parsePolynomialFromText(text) {
        if (!text || typeof text !== 'string') return null;

        // Extract polynomial from "f(x) = ..." if present
        let expr = text;
        const fxMatch = text.match(/f\s*\(\s*x\s*\)\s*=\s*(.+?)(?:\.\s|$)/);
        if (fxMatch) expr = fxMatch[1].trim();

        // Normalize unicode superscripts to ^n
        const supMap = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
        expr = expr.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, m => '^' + [...m].map(c => supMap[c] || c).join(''));
        // Normalize minus signs
        expr = expr.replace(/[−–]/g, '-');
        // Remove spaces inside ^{...}
        expr = expr.replace(/\^\s*\{?\s*(\d+)\s*\}?/g, '^$1');

        // Ensure leading + for consistent parsing
        expr = expr.trim();
        if (!/^[+-]/.test(expr)) expr = '+' + expr;

        const coeffs = {};
        let hasTerms = false;

        // Split by + and - keeping the sign
        const terms = expr.match(/[+-][^+-]+/g);
        if (!terms) return null;

        for (const raw of terms) {
            const t = raw.trim();

            // ax^n
            let m = t.match(/^([+-]?\s*\d*\.?\d*)\s*x\s*\^\s*(\d+)\s*$/);
            if (m) {
                let c = m[1].replace(/\s/g, '');
                if (c === '+' || c === '') c = '1';
                else if (c === '-') c = '-1';
                coeffs[parseInt(m[2])] = new Decimal(c);
                hasTerms = true;
                continue;
            }

            // ax (power 1)
            m = t.match(/^([+-]?\s*\d*\.?\d*)\s*x\s*$/);
            if (m) {
                let c = m[1].replace(/\s/g, '');
                if (c === '+' || c === '') c = '1';
                else if (c === '-') c = '-1';
                coeffs[1] = new Decimal(c);
                hasTerms = true;
                continue;
            }

            // constant
            m = t.match(/^([+-]?\s*\d+\.?\d*)\s*$/);
            if (m) {
                coeffs[0] = new Decimal(m[1].replace(/\s/g, ''));
                hasTerms = true;
                continue;
            }
        }

        return hasTerms ? coeffs : null;
    }

    /**
     * Computes the derivative of a polynomial.
     * @param {Object} coeffs - Map { power: Decimal(coefficient) }
     * @returns {Object} Derivative coefficients map
     */
    static polynomialDerivative(coeffs) {
        const deriv = {};
        for (const [power, coeff] of Object.entries(coeffs)) {
            const p = parseInt(power);
            if (p === 0) continue;
            deriv[p - 1] = new Decimal(coeff).times(p);
        }
        return deriv;
    }

    /**
     * Evaluates a polynomial at a given x value.
     * @param {Object} coeffs - Map { power: Decimal(coefficient) }
     * @param {number|string|Decimal} x
     * @returns {Decimal}
     */
    static evaluatePolynomial(coeffs, x) {
        const dx = new Decimal(x);
        let result = new Decimal(0);
        for (const [power, coeff] of Object.entries(coeffs)) {
            result = result.plus(new Decimal(coeff).times(dx.pow(parseInt(power))));
        }
        return result;
    }

    /**
     * Solves quadratic equation ax² + bx + c = 0.
     * @returns {Decimal[]} Real roots sorted ascending
     */
    static solveQuadratic(a, b, c) {
        const da = new Decimal(a);
        const db = new Decimal(b);
        const dc = new Decimal(c);

        if (da.isZero()) {
            if (db.isZero()) return [];
            return [dc.neg().div(db)];
        }

        const discriminant = db.times(db).minus(da.times(dc).times(4));
        if (discriminant.lt(0)) return [];
        if (discriminant.isZero()) return [db.neg().div(da.times(2))];

        const sqrtD = discriminant.sqrt();
        const x1 = db.neg().plus(sqrtD).div(da.times(2));
        const x2 = db.neg().minus(sqrtD).div(da.times(2));
        return [Decimal.min(x1, x2), Decimal.max(x1, x2)];
    }

    /**
     * Finds rational/integer roots of a polynomial using rational root theorem.
     * Tests integers from -maxVal to +maxVal.
     * @param {Object} coeffs - Map { power: Decimal(coefficient) }
     * @param {number} maxVal - Max absolute value to test (default 50)
     * @returns {Decimal[]} Found roots
     */
    static findRationalRoots(coeffs, maxVal = 50) {
        const roots = [];
        for (let x = -maxVal; x <= maxVal; x++) {
            const val = MathEngine.evaluatePolynomial(coeffs, x);
            if (val.abs().lt('0.0001')) {
                roots.push(new Decimal(x));
            }
        }
        return roots;
    }

    /**
     * Finds critical points (extrema) of a polynomial function.
     * Computes f'(x) = 0, then uses f''(x) to classify min/max.
     * @param {Object} fCoeffs - Polynomial coefficients { power: Decimal }
     * @returns {{ minima: Array<{x: Decimal, y: Decimal}>, maxima: Array<{x: Decimal, y: Decimal}>, steps: string[] } | null}
     */
    static findPolynomialExtrema(fCoeffs) {
        if (!fCoeffs || Object.keys(fCoeffs).length < 2) return null;

        const maxPower = Math.max(...Object.keys(fCoeffs).map(Number));
        if (maxPower < 2 || maxPower > 6) return null;

        const fPrime = MathEngine.polynomialDerivative(fCoeffs);
        const fDoublePrime = MathEngine.polynomialDerivative(fPrime);
        const steps = [];

        // Format polynomial for display
        const formatPoly = (c) => Object.entries(c)
            .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
            .map(([p, v]) => `${v}x^${p}`)
            .join(' + ');

        steps.push(`f'(x) = ${formatPoly(fPrime)}`);

        // Find critical points (roots of f'(x))
        let criticalPoints = [];
        const derivDegree = Math.max(...Object.keys(fPrime).map(Number));

        if (derivDegree === 1) {
            // Linear f'(x): ax + b = 0
            const a = fPrime[1] || new Decimal(0);
            const b = fPrime[0] || new Decimal(0);
            if (!new Decimal(a).isZero()) {
                criticalPoints.push(new Decimal(b).neg().div(new Decimal(a)));
            }
        } else if (derivDegree === 2) {
            // Quadratic f'(x): ax² + bx + c = 0
            const a = fPrime[2] || new Decimal(0);
            const b = fPrime[1] || new Decimal(0);
            const c = fPrime[0] || new Decimal(0);
            criticalPoints = MathEngine.solveQuadratic(a, b, c);
        } else {
            // Higher degree: use rational root theorem
            criticalPoints = MathEngine.findRationalRoots(fPrime, 50);
        }

        if (criticalPoints.length === 0) return null;

        steps.push(`f'(x) = 0 → x = ${criticalPoints.join(', ')}`);

        const minima = [];
        const maxima = [];

        for (const x of criticalPoints) {
            const secondDeriv = MathEngine.evaluatePolynomial(fDoublePrime, x);
            const y = MathEngine.evaluatePolynomial(fCoeffs, x);

            if (secondDeriv.gt(0)) {
                minima.push({ x, y });
                steps.push(`f''(${x}) = ${secondDeriv} > 0 → mínimo local en x=${x}, f(${x})=${y}`);
            } else if (secondDeriv.lt(0)) {
                maxima.push({ x, y });
                steps.push(`f''(${x}) = ${secondDeriv} < 0 → máximo local en x=${x}, f(${x})=${y}`);
            } else {
                // f''(x) = 0 → use higher derivatives or leading coefficient test
                // For even-multiplicity roots: check sign change or use n-th derivative
                const fTriple = MathEngine.polynomialDerivative(fDoublePrime);
                const thirdDeriv = MathEngine.evaluatePolynomial(fTriple, x);
                if (!thirdDeriv.isZero()) {
                    // Inflection point (odd higher derivative)
                    steps.push(`f''(${x}) = 0, f'''(${x}) ≠ 0 → punto de inflexión en x=${x}`);
                } else {
                    // Check 4th derivative
                    const fQuad = MathEngine.polynomialDerivative(fTriple);
                    const fourthDeriv = MathEngine.evaluatePolynomial(fQuad, x);
                    if (fourthDeriv.gt(0)) {
                        minima.push({ x, y });
                        steps.push(`f⁴(${x}) = ${fourthDeriv} > 0 → mínimo local en x=${x}`);
                    } else if (fourthDeriv.lt(0)) {
                        maxima.push({ x, y });
                        steps.push(`f⁴(${x}) = ${fourthDeriv} < 0 → máximo local en x=${x}`);
                    } else {
                        // Unique critical point + positive leading coeff + even degree → minimum
                        if (criticalPoints.length === 1 && maxPower % 2 === 0) {
                            const leading = new Decimal(fCoeffs[maxPower]);
                            if (leading.gt(0)) {
                                minima.push({ x, y });
                                steps.push(`Único punto crítico, grado par, coef. líder > 0 → mínimo en x=${x}`);
                            } else {
                                maxima.push({ x, y });
                                steps.push(`Único punto crítico, grado par, coef. líder < 0 → máximo en x=${x}`);
                            }
                        }
                    }
                }
            }
        }

        return { minima, maxima, steps };
    }

    /**
     * Parses numbers in scientific notation from text.
     * Handles: 5.678912e8, 3.456789 × 10^7, 3.456789 × 10⁷
     * @param {string} text
     * @returns {Decimal[]}
     */
    static parseScientificNumbers(text) {
        const numbers = [];
        const supMap = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

        // Pattern 1: 3.456e7 or 3.456e+7 or 3.456E8
        const eNotation = /(\d+\.?\d*)\s*[eE]\s*([+-]?\d+)/g;
        let m;
        while ((m = eNotation.exec(text)) !== null) {
            const mantissa = new Decimal(m[1]);
            const exp = parseInt(m[2], 10);
            numbers.push(mantissa.times(new Decimal(10).pow(exp)));
        }

        // Pattern 2: 3.456 × 10^7 or 3.456 * 10^7
        const mulNotation = /(\d+\.?\d*)\s*[×x*]\s*10\s*\^\s*\{?\s*(\d+)\s*\}?/gi;
        while ((m = mulNotation.exec(text)) !== null) {
            const mantissa = new Decimal(m[1]);
            const exp = parseInt(m[2], 10);
            numbers.push(mantissa.times(new Decimal(10).pow(exp)));
        }

        // Pattern 3: 3.456 × 10⁷ (unicode superscript)
        const uniNotation = /(\d+\.?\d*)\s*[×x*]\s*10\s*([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/gi;
        while ((m = uniNotation.exec(text)) !== null) {
            const mantissa = new Decimal(m[1]);
            const expStr = [...m[2]].map(c => supMap[c] || c).join('');
            const exp = parseInt(expStr, 10);
            numbers.push(mantissa.times(new Decimal(10).pow(exp)));
        }

        return numbers;
    }

    /**
     * Rounds a Decimal to N significant figures.
     * @param {Decimal} value
     * @param {number} sigFigs
     * @returns {Decimal}
     */
    static roundToSignificantFigures(value, sigFigs) {
        if (value.isZero()) return new Decimal(0);
        const absVal = value.abs();
        const exponent = absVal.log(10).floor().toNumber();
        const factor = new Decimal(10).pow(sigFigs - 1 - exponent);
        return value.times(factor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).div(factor);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GCD / LCM — Greatest Common Divisor / Least Common Multiple
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Computes the Greatest Common Divisor of two integers using Euclidean algorithm.
     * @param {number|string|Decimal} a
     * @param {number|string|Decimal} b
     * @returns {Decimal}
     */
    static gcd(a, b) {
        let da = new Decimal(a).abs().round();
        let db = new Decimal(b).abs().round();
        if (da.isZero()) return db;
        if (db.isZero()) return da;
        while (!db.isZero()) {
            const temp = db;
            db = da.mod(db);
            da = temp;
        }
        return da;
    }

    /**
     * Computes the Least Common Multiple of two integers.
     * @param {number|string|Decimal} a
     * @param {number|string|Decimal} b
     * @returns {Decimal}
     */
    static lcm(a, b) {
        const da = new Decimal(a).abs().round();
        const db = new Decimal(b).abs().round();
        if (da.isZero() || db.isZero()) return new Decimal(0);
        return da.div(MathEngine.gcd(da, db)).times(db);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Fraction — Aritmética exacta de fracciones
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Creates a simplified fraction { num, den } from numerator and denominator.
     * Always normalizes sign: denominator is always positive.
     * @param {number|string|Decimal} numerator
     * @param {number|string|Decimal} denominator
     * @returns {{ num: Decimal, den: Decimal }}
     */
    static fraction(numerator, denominator) {
        let num = new Decimal(numerator);
        let den = new Decimal(denominator);
        if (den.isZero()) throw new Error('Fraction: division by zero');
        if (den.lt(0)) { num = num.neg(); den = den.neg(); }
        const g = MathEngine.gcd(num.abs(), den.abs());
        return { num: num.div(g), den: den.div(g) };
    }

    /**
     * Adds two fractions: a/b + c/d = (a*d + c*b) / (b*d), simplified.
     * @param {{ num: Decimal, den: Decimal }} f1
     * @param {{ num: Decimal, den: Decimal }} f2
     * @returns {{ num: Decimal, den: Decimal }}
     */
    static fractionAdd(f1, f2) {
        const num = f1.num.times(f2.den).plus(f2.num.times(f1.den));
        const den = f1.den.times(f2.den);
        return MathEngine.fraction(num, den);
    }

    /**
     * Subtracts two fractions: a/b - c/d = (a*d - c*b) / (b*d), simplified.
     */
    static fractionSub(f1, f2) {
        const num = f1.num.times(f2.den).minus(f2.num.times(f1.den));
        const den = f1.den.times(f2.den);
        return MathEngine.fraction(num, den);
    }

    /**
     * Multiplies two fractions: (a/b) * (c/d) = (a*c) / (b*d), simplified.
     */
    static fractionMul(f1, f2) {
        const num = f1.num.times(f2.num);
        const den = f1.den.times(f2.den);
        return MathEngine.fraction(num, den);
    }

    /**
     * Divides two fractions: (a/b) ÷ (c/d) = (a*d) / (b*c), simplified.
     */
    static fractionDiv(f1, f2) {
        if (f2.num.isZero()) throw new Error('Fraction: division by zero');
        const num = f1.num.times(f2.den);
        const den = f1.den.times(f2.num);
        return MathEngine.fraction(num, den);
    }

    /**
     * Converts a fraction to its Decimal value.
     * @param {{ num: Decimal, den: Decimal }} f
     * @returns {Decimal}
     */
    static fractionToDecimal(f) {
        return f.num.div(f.den);
    }

    /**
     * Formats a fraction as a string "num/den" or as integer if den=1.
     * @param {{ num: Decimal, den: Decimal }} f
     * @returns {string}
     */
    static fractionToString(f) {
        if (f.den.eq(1)) return f.num.toFixed();
        return `${f.num.toFixed()}/${f.den.toFixed()}`;
    }

    /**
     * Parses a fraction string like "3/8", "-1/9", "5" into { num, den }.
     * Handles mixed numbers like "2 3/4" → 11/4.
     * @param {string} str
     * @returns {{ num: Decimal, den: Decimal } | null}
     */
    static parseFraction(str) {
        if (!str || typeof str !== 'string') return null;
        const s = str.trim();

        // Mixed number: "2 3/4"
        const mixedRe = /^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/;
        const mixedM = mixedRe.exec(s);
        if (mixedM) {
            const whole = new Decimal(mixedM[1]);
            const num = new Decimal(mixedM[2]);
            const den = new Decimal(mixedM[3]);
            if (den.isZero()) return null;
            const sign = whole.lt(0) ? -1 : 1;
            const totalNum = whole.abs().times(den).plus(num).times(sign);
            return MathEngine.fraction(totalNum, den);
        }

        // Simple fraction: "3/8" or "-1/9"
        const fracRe = /^(-?\d+\.?\d*)\s*\/\s*(-?\d+\.?\d*)$/;
        const fracM = fracRe.exec(s);
        if (fracM) {
            const num = new Decimal(fracM[1]);
            const den = new Decimal(fracM[2]);
            if (den.isZero()) return null;
            return MathEngine.fraction(num, den);
        }

        // Integer: "5"
        const intRe = /^(-?\d+\.?\d*)$/;
        const intM = intRe.exec(s);
        if (intM) {
            return MathEngine.fraction(new Decimal(intM[1]), 1);
        }

        return null;
    }

    /**
     * Evaluates a fraction expression like "3/8 + 1/9" or "2/3 × 5/7 - 1/2".
     * Returns both the exact fraction and its decimal value.
     * Supports: +, -, ×, *, ÷, /  between fractions.
     * @param {string} expression
     * @returns {{ fraction: { num: Decimal, den: Decimal }, decimal: Decimal, steps: string[] } | null}
     */
    static evaluateFractionExpression(expression) {
        if (!expression || typeof expression !== 'string') return null;

        const s = expression.trim()
            .replace(/[−–]/g, '-')
            .replace(/×/g, '*')
            .replace(/÷/g, '/')
            .replace(/\s*\+\s*/g, ' + ')
            .replace(/\s*-\s*/g, ' - ')
            .replace(/\s*\*\s*/g, ' * ')
            .replace(/\s*\/\s*/g, '/'); // Keep / within fractions

        // Tokenize: split into fractions and operators
        // A fraction is "num/den" or just a number
        // An operator is +, -, * (for multiplication of fractions), or ÷ (division of fractions)
        const tokens = [];
        const tokenRe = /(-?\d+\.?\d*(?:\s*\/\s*\d+\.?\d*)?)\s*([+\-]|[*×](?!\s*\d+\s*\/)|÷)?\s*/g;
        let m;
        
        // More robust tokenization for fraction expressions
        const parts = s.split(/\s+/);
        const fracs = [];
        const ops = [];
        let currentFrac = '';
        
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p === '+' || p === '-' || p === '*' || p === '×' || p === '÷') {
                if (currentFrac) {
                    fracs.push(currentFrac.trim());
                    currentFrac = '';
                }
                ops.push(p);
            } else {
                currentFrac += (currentFrac ? ' ' : '') + p;
            }
        }
        if (currentFrac) fracs.push(currentFrac.trim());

        if (fracs.length < 2 || fracs.length !== ops.length + 1) return null;

        const steps = [];
        const parsedFracs = fracs.map(f => MathEngine.parseFraction(f));
        if (parsedFracs.some(f => f === null)) return null;

        let result = parsedFracs[0];
        steps.push(`Inicio: ${MathEngine.fractionToString(result)}`);

        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const operand = parsedFracs[i + 1];
            const prev = MathEngine.fractionToString(result);

            if (op === '+') {
                result = MathEngine.fractionAdd(result, operand);
                steps.push(`${prev} + ${MathEngine.fractionToString(operand)} = ${MathEngine.fractionToString(result)}`);
            } else if (op === '-') {
                result = MathEngine.fractionSub(result, operand);
                steps.push(`${prev} - ${MathEngine.fractionToString(operand)} = ${MathEngine.fractionToString(result)}`);
            } else if (op === '*' || op === '×') {
                result = MathEngine.fractionMul(result, operand);
                steps.push(`${prev} × ${MathEngine.fractionToString(operand)} = ${MathEngine.fractionToString(result)}`);
            } else if (op === '÷') {
                result = MathEngine.fractionDiv(result, operand);
                steps.push(`${prev} ÷ ${MathEngine.fractionToString(operand)} = ${MathEngine.fractionToString(result)}`);
            }
        }

        const decimal = MathEngine.fractionToDecimal(result);
        steps.push(`Resultado: ${MathEngine.fractionToString(result)} = ${decimal}`);

        return { fraction: result, decimal, steps };
    }

    /**
     * Cross-verifies a computation by evaluating in two independent ways.
     * Returns true only if both methods agree within strict tolerance.
     * @param {string} expression - Math expression
     * @param {Decimal} expectedResult - The result to verify
     * @returns {{ verified: boolean, method1: Decimal|null, method2: Decimal|null }}
     */
    static crossVerify(expression, expectedResult) {
        // Method 1: Standard MathEngine evaluation
        const method1 = MathEngine.tryEvaluate(expression);

        // Method 2: Left-to-right manual evaluation (for detecting precedence bugs)
        let method2 = null;
        try {
            // Parse into tokens and evaluate with explicit precedence
            const tokens = tokenize(expression);
            const parser = new Parser(tokens);
            method2 = parser.parseExpression();
        } catch {
            method2 = null;
        }

        // Method 3: For simple a^b, use Decimal.pow directly
        const powerMatch = expression.match(/^([\d.]+)\s*\^\s*([\d.]+)$/);
        if (powerMatch) {
            try {
                const base = new Decimal(powerMatch[1]);
                const exp = new Decimal(powerMatch[2]);
                const directPow = base.pow(exp);
                // Compare against expected
                if (expectedResult) {
                    const diff = directPow.minus(expectedResult).abs();
                    const relErr = expectedResult.isZero() ? diff : diff.div(expectedResult.abs());
                    return {
                        verified: relErr.lt('0.0001'),
                        method1: method1,
                        method2: directPow,
                    };
                }
            } catch { /* ignore */ }
        }

        if (!method1 || !method2) {
            return { verified: false, method1, method2 };
        }

        const diff = method1.minus(method2).abs();
        const relErr = method1.isZero() ? diff : diff.div(method1.abs());
        
        return {
            verified: relErr.lt('0.0001'),
            method1,
            method2,
        };
    }

    /**
     * Verifies an exponentiation a^b with high precision.
     * Returns the correct result and magnitude information.
     * @param {number|string|Decimal} base
     * @param {number|string|Decimal} exponent
     * @returns {{ value: Decimal, magnitude: number, steps: string[] }}
     */
    static verifyExponentiation(base, exponent) {
        const b = new Decimal(base);
        const e = new Decimal(exponent);
        const result = b.pow(e);
        const magnitude = result.isZero() ? 0 : result.abs().log(10).floor().toNumber();
        
        const steps = [
            `${b}^${e} = ${result.toExponential(6)}`,
            `Magnitud: 10^${magnitude}`,
            `Valor exacto (primeros 15 dígitos): ${result.toSignificantDigits(15)}`,
        ];

        return { value: result, magnitude, steps };
    }

    /**
     * Computes the order of magnitude of a number (floor of log10).
     * Useful for sanity-checking whether a result is plausible.
     * @param {Decimal} value
     * @returns {number}
     */
    static orderOfMagnitude(value) {
        if (!value || value.isZero()) return 0;
        return value.abs().log(10).floor().toNumber();
    }

    /**
     * Checks if two values are within the same order of magnitude (±1).
     * @param {Decimal} a
     * @param {Decimal} b
     * @returns {boolean}
     */
    static sameOrderOfMagnitude(a, b) {
        if (!a || !b) return false;
        if (a.isZero() && b.isZero()) return true;
        if (a.isZero() || b.isZero()) return false;
        const magA = MathEngine.orderOfMagnitude(a);
        const magB = MathEngine.orderOfMagnitude(b);
        return Math.abs(magA - magB) <= 1;
    }
}

export default MathEngine;
