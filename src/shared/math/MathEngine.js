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
}

export default MathEngine;
