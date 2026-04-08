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
            // ═══════════════════════════════════════════════════════════════════
            // NOTACIÓN CIENTÍFICA: convertir ANTES de alinear
            // No puedes alinear decimales si los números están en notación
            // científica — primero debes convertirlos a forma decimal.
            // ═══════════════════════════════════════════════════════════════════
            [/(?:convert[ie]r|transform[ae]r|expres[ae]r|expand[ie]r|pasar|cambiar)\s+(?:a\s+)?(?:forma\s+)?(?:decimal|est[aá]ndar|normal)|(?:notaci[oó]n\s+(?:decimal|est[aá]ndar|normal))/,
                /(?:aline[ae]r|aline[ae]mos|aline[ae]ci[oó]n|colocar\s+(?:los\s+)?(?:n[uú]meros|valores)\s+(?:en\s+)?columna|(?:uno\s+debajo|vertical))/,
                'Debe convertirse a forma decimal ANTES de alinear'
            ],
            [/(?:convert[ie]r|transform[ae]r|expres[ae]r|expand[ie]r|pasar)\s+(?:a\s+)?(?:forma\s+)?(?:decimal|est[aá]ndar)/,
                /(?:sumar|restar|operar|calcular)\s+(?:columna|cifra|d[ií]gito)/,
                'Debe convertirse a forma decimal ANTES de operar columnas'
            ],
            // Alinear decimales presupone tener los números en decimal
            [/(?:aline[ae]r|aline[ae]mos|aline[ae]ci[oó]n)\s+(?:(?:los|las|por)\s+)?(?:(?:puntos?|comas?)\s+)?(?:decimal)/,
                /(?:sumar|restar|operar|calcular)/,
                'Debe alinearse antes de operar'
            ],
            // ═══════════════════════════════════════════════════════════════════
            // SERIES: identificar parámetros ANTES de aplicar fórmula
            // ═══════════════════════════════════════════════════════════════════
            [/(?:identificar|determinar|encontrar|extraer|obtener)\s+(?:(?:los|las|el|la)\s+)?(?:par[aá]metros?|valores|datos|raz[oó]n|diferencia|primer\s+t[eé]rmino)/,
                /(?:aplicar|usar|utilizar|sustituir)\s+(?:(?:la|el)\s+)?(?:f[oó]rmula)/,
                'Debe identificar los parámetros ANTES de aplicar la fórmula'
            ],
            [/(?:aplicar|usar|utilizar|sustituir)\s+(?:(?:la|el)\s+)?(?:f[oó]rmula)/,
                /(?:obtener|calcular|determinar)\s+(?:(?:el|la)\s+)?(?:resultado|suma|total|valor)\s+(?:final|num[eé]rico)/,
                'Debe aplicar la fórmula ANTES de obtener el resultado numérico'
            ],
            // ═══════════════════════════════════════════════════════════════════
            // DERIVADAS: derivar ANTES de igualar a cero
            // ═══════════════════════════════════════════════════════════════════
            [/(?:calcular|obtener|hallar|encontrar)\s+(?:la\s+)?(?:derivada|f')/,
                /(?:igualar|resolver)\s+(?:a\s+)?(?:cero|0)/,
                'Debe calcularse la derivada ANTES de igualar a cero'
            ],
            [/(?:igualar|resolver)\s+(?:la\s+)?(?:derivada|f')\s+(?:a\s+)?(?:cero|0)/,
                /(?:evaluar|sustituir|clasificar)\s+(?:(?:el|la|los|las|en)\s+)*(?:punto|valor|extremo|m[ií]nimo|m[aá]ximo)/,
                'Debe resolverse f\'(x)=0 ANTES de clasificar extremos'
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
// Etapa 4.5: ExplanationStepOrderStage
// —
// Valida y corrige el orden lógico de pasos en las explicaciones de
// preguntas de TODOS los tipos (multiple_choice, fill_in_blank).
// Detecta cuando la explicación describe pasos en orden incorrecto
// (e.g., "Paso 1: Alinear decimales. Paso 2: Convertir a decimal.")
// y reordena la explicación para que sea pedagógicamente correcta.
//
// Principio: No puedes ejecutar un paso que depende del resultado
// de otro paso anterior. Las dependencias son transitivas.
// ═══════════════════════════════════════════════════════════════════════════

class ExplanationStepOrderStage {
    constructor() {
        // Dependency rules: [prerequisite, dependent, description]
        // DEPENDENT must come AFTER PREREQUISITE in the explanation.
        this.rules = [
            // ── Notación científica: convertir ANTES de alinear ──────────────
            {
                prereq: /convert[ie]r|transform[ae]r|expres[ae]r|expand[ie]r|pasar\s+a\s+(?:forma\s+)?decimal|notaci[oó]n\s+(?:decimal|est[aá]ndar)|(?:forma\s+(?:decimal|est[aá]ndar))/i,
                dependent: /aline[ae]r|aline[ae]ci[oó]n|(?:por\s+(?:el|la|los|las)\s+)?(?:punto|coma)\s+decimal|columna/i,
                desc: 'Convertir a decimal ANTES de alinear',
                context: /notaci[oó]n\s+cient[ií]fica|[eE]\d+|10\s*\^/i,
            },
            // ── Alinear ANTES de sumar ───────────────────────────────────────
            {
                prereq: /aline[ae]r|aline[ae]ci[oó]n|columna/i,
                dependent: /sumar|restar|operar|(?:de\s+)?(?:derecha\s+a\s+izquierda|izquierda\s+a\s+derecha)/i,
                desc: 'Alinear ANTES de sumar/operar',
                context: /notaci[oó]n\s+cient[ií]fica|aline|decimal/i,
            },
            // ── Series: identificar parámetros ANTES de fórmula ──────────────
            {
                prereq: /identificar|determinar|extraer|par[aá]metros?|raz[oó]n\s+com[uú]n|diferencia\s+com[uú]n|primer\s+t[eé]rmino|a[_₁1]\s*=/i,
                dependent: /aplicar\s+(?:la\s+)?f[oó]rmula|sustituir\s+en|S[_n]\s*=/i,
                desc: 'Identificar parámetros ANTES de aplicar fórmula',
                context: /serie|progresi[oó]n|sumatoria|[Σ∑]/i,
            },
            // ── Fórmula ANTES de resultado numérico ──────────────────────────
            {
                prereq: /aplicar\s+(?:la\s+)?f[oó]rmula|sustituir|S[_n]\s*=/i,
                dependent: /resultado\s+(?:final|num[eé]rico)|total\s*[:=]|=\s*\d/i,
                desc: 'Aplicar fórmula ANTES de mostrar resultado',
                context: /serie|sumatoria|f[oó]rmula/i,
            },
            // ── Derivar ANTES de igualar a cero ─────────────────────────────
            {
                prereq: /derivada|f'\(x\)|d\/dx/i,
                dependent: /igualar\s+a\s+cero|=\s*0|ra[ií]ces|puntos?\s+cr[ií]ticos?/i,
                desc: 'Calcular derivada ANTES de igualar a cero',
                context: /derivada|extremo|m[ií]nimo|m[aá]ximo|cr[ií]tico/i,
            },
            // ── Operar ANTES de escribir resultado ──────────────────────────
            {
                prereq: /sumar|restar|multiplicar|dividir|calcular|operar|resolver|evaluar/i,
                dependent: /(?:escribir|anotar|registrar)\s+(?:el\s+)?resultado\s+final/i,
                desc: 'Operar ANTES de escribir resultado',
                context: null, // aplica siempre
            },
            // ── Calcular ANTES de verificar ──────────────────────────────────
            {
                prereq: /calcular|obtener|determinar|resultado/i,
                dependent: /verificar|comprobar|revisar|prueba/i,
                desc: 'Calcular ANTES de verificar',
                context: null,
            },
        ];
    }

    process(q) {
        if (!q || !q.explanation) return { action: 'pass', question: q };
        if (q.type === 'ordering') return { action: 'pass', question: q };

        const explanation = q.explanation;

        // Extract numbered steps from explanation
        const steps = this._extractSteps(explanation);
        if (steps.length < 2) return { action: 'pass', question: q };

        // Check context to decide which rules apply
        const questionText = (q.question || '') + ' ' + explanation;

        // Detect violations
        const violations = this._detectViolations(steps, questionText);

        if (violations.length === 0) return { action: 'pass', question: q };

        // Try to reorder steps to fix violations
        const reordered = this._reorderSteps(steps, questionText);

        if (reordered) {
            const fixedExplanation = this._rebuildExplanation(explanation, steps, reordered);
            console.warn(
                `[ValidationPipeline] EXPLANATION REORDERED: ${violations.length} dependency violation(s) fixed.` +
                ` Question: "${(q.question || '').substring(0, 60)}..."`
            );
            for (const v of violations) {
                console.warn(`  ↳ ${v}`);
            }
            q.explanation = fixedExplanation;
        } else {
            // Could not fix — log but don't reject (explanation errors are less critical
            // than answer errors, and the math IS correct)
            console.warn(
                `[ValidationPipeline] EXPLANATION ORDER WARNING (unfixable): ` +
                `${violations.join('; ')} — Question: "${(q.question || '').substring(0, 60)}..."`
            );
        }

        return { action: 'pass', question: q };
    }

    /**
     * Extracts numbered steps from explanation text.
     * Supports multiple formats:
     *   "Paso 1: ...", "1. ...", "1) ...", "Primero, ..."
     */
    _extractSteps(text) {
        const steps = [];

        // Format: "Paso N: text" or "N. text" or "N) text"
        const stepRe = /(?:Paso\s+)?(\d+)[.):]+\s*([^.]+(?:\.[^\d])?[^]*?)(?=(?:Paso\s+)?\d+[.):]|$)/gi;
        let m;
        while ((m = stepRe.exec(text)) !== null) {
            const num = parseInt(m[1], 10);
            const content = m[2].trim();
            if (content.length > 5) {
                steps.push({ num, content, original: m[0] });
            }
        }

        if (steps.length >= 2) return steps;

        // Fallback: split by sentence and detect order words
        const sentences = text.split(/\.\s+/).filter(s => s.trim().length > 10);
        if (sentences.length >= 2) {
            return sentences.map((s, i) => ({ num: i + 1, content: s.trim(), original: s }));
        }

        return [];
    }

    /**
     * Detects dependency violations in numbered steps.
     */
    _detectViolations(steps, questionText) {
        const violations = [];
        const lowerContents = steps.map(s => s.content.toLowerCase());

        for (const rule of this.rules) {
            // Check if rule context applies to this question
            if (rule.context && !rule.context.test(questionText)) continue;

            let prereqIdx = -1;
            let dependentIdx = -1;

            for (let i = 0; i < lowerContents.length; i++) {
                if (prereqIdx < 0 && rule.prereq.test(lowerContents[i])) prereqIdx = i;
                if (dependentIdx < 0 && rule.dependent.test(lowerContents[i])) dependentIdx = i;
            }

            // Violation: dependent appears before prerequisite
            if (prereqIdx >= 0 && dependentIdx >= 0 && dependentIdx < prereqIdx) {
                violations.push(
                    `Paso ${steps[dependentIdx].num} ("${steps[dependentIdx].content.substring(0, 40)}...") ` +
                    `depende de Paso ${steps[prereqIdx].num} ("${steps[prereqIdx].content.substring(0, 40)}..."): ` +
                    rule.desc
                );
            }
        }

        return violations;
    }

    /**
     * Topological sort of steps based on dependency rules.
     * Returns reordered array or null if cycle detected.
     */
    _reorderSteps(steps, questionText) {
        const n = steps.length;
        const lowerContents = steps.map(s => s.content.toLowerCase());

        // Build adjacency: edges[i] = set of indices that must come AFTER i
        const edges = Array.from({ length: n }, () => new Set());
        const inDegree = new Array(n).fill(0);

        for (const rule of this.rules) {
            if (rule.context && !rule.context.test(questionText)) continue;

            const prereqIndices = [];
            const dependentIndices = [];

            for (let i = 0; i < lowerContents.length; i++) {
                if (rule.prereq.test(lowerContents[i])) prereqIndices.push(i);
                if (rule.dependent.test(lowerContents[i])) dependentIndices.push(i);
            }

            // prereq → dependent (prereq must come first)
            for (const pi of prereqIndices) {
                for (const di of dependentIndices) {
                    if (pi !== di && !edges[pi].has(di)) {
                        edges[pi].add(di);
                        inDegree[di]++;
                    }
                }
            }
        }

        // Kahn's algorithm for topological sort
        const queue = [];
        for (let i = 0; i < n; i++) {
            if (inDegree[i] === 0) queue.push(i);
        }

        const order = [];
        while (queue.length > 0) {
            // Prefer original order among candidates with same in-degree
            queue.sort((a, b) => a - b);
            const node = queue.shift();
            order.push(node);
            for (const neighbor of edges[node]) {
                inDegree[neighbor]--;
                if (inDegree[neighbor] === 0) queue.push(neighbor);
            }
        }

        // Cycle detected
        if (order.length !== n) return null;

        // Check if order actually changed
        const orderChanged = order.some((idx, pos) => idx !== pos);
        if (!orderChanged) return null;

        return order.map(i => steps[i]);
    }

    /**
     * Rebuilds the explanation text with reordered steps.
     */
    _rebuildExplanation(originalText, originalSteps, reorderedSteps) {
        // If original uses numbered format, rebuild with correct numbers
        const parts = [];
        for (let i = 0; i < reorderedSteps.length; i++) {
            parts.push(`Paso ${i + 1}: ${reorderedSteps[i].content}`);
        }

        // Preserve any trailing text after the last step
        const lastOriginal = originalSteps[originalSteps.length - 1];
        const lastIdx = originalText.lastIndexOf(lastOriginal.original);
        let suffix = '';
        if (lastIdx >= 0) {
            suffix = originalText.substring(lastIdx + lastOriginal.original.length).trim();
        }

        return parts.join('. ') + (suffix ? '. ' + suffix : '.');
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
// Etapa 7.5: FractionVerificationStage — Verifica aritmética de fracciones
// ═══════════════════════════════════════════════════════════════════════════

class FractionVerificationStage {
    process(q) {
        if (!q || (q.type !== 'multiple_choice' && q.type !== 'fill_in_blank')) {
            return { action: 'pass', question: q };
        }

        const text = q.question || '';
        // Only process questions that contain fractions
        const fracPat = /(\d+)\s*\/\s*(\d+)/g;
        const fracs = [];
        let fm;
        while ((fm = fracPat.exec(text)) !== null) {
            const den = parseInt(fm[2], 10);
            if (den > 0 && den <= 10000) {
                fracs.push({ num: parseInt(fm[1], 10), den });
            }
        }
        if (fracs.length < 2) return { action: 'pass', question: q };

        // If the question asks for a fraction result, verify correctAnswer is valid
        if (q.type === 'fill_in_blank') {
            const answer = String(q.correctAnswer || '');
            const parsedFrac = MathEngine.parseFraction(answer);
            if (parsedFrac) {
                // Verify it's in simplified form
                const gcd = MathEngine.gcd(parsedFrac.num.abs(), parsedFrac.den);
                if (!gcd.eq(1)) {
                    // Simplify and correct
                    const simplified = MathEngine.fraction(parsedFrac.num, parsedFrac.den);
                    console.warn(
                        `[ValidationPipeline] FRACTION SIMPLIFIED: ${answer} → ${MathEngine.fractionToString(simplified)}`
                    );
                    q.correctAnswer = MathEngine.fractionToString(simplified);
                }
            }
        }

        return { action: 'pass', question: q };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 7.8: ExponentiationMagnitudeStage — Verifica magnitud de potencias
// ═══════════════════════════════════════════════════════════════════════════

class ExponentiationMagnitudeStage {
    process(q) {
        if (!q || q.type !== 'multiple_choice') return { action: 'pass', question: q };

        const text = q.question || '';
        // Detect exponentiation pattern
        const powMatch = text.match(/(\d+\.?\d*)\s*\^\s*(\d+\.?\d*)/);
        if (!powMatch) return { action: 'pass', question: q };

        const base = MathEngine.parseDecimal(powMatch[1]);
        const exponent = MathEngine.parseDecimal(powMatch[2]);
        if (!base || !exponent || base.lte(1) || exponent.lte(1)) {
            return { action: 'pass', question: q };
        }

        // Compute the real result
        try {
            const result = base.pow(exponent);
            const magnitude = MathEngine.orderOfMagnitude(result);

            // Check if any option is in the right magnitude
            let maxOptMag = -Infinity;
            let minOptMag = Infinity;
            for (const opt of q.options) {
                const val = MathEngine.parseDecimal(String(opt).replace(/[^\d.eE+\-]/g, ''));
                if (val && val.gt(0)) {
                    const optMag = MathEngine.orderOfMagnitude(val);
                    maxOptMag = Math.max(maxOptMag, optMag);
                    minOptMag = Math.min(minOptMag, optMag);
                }
            }

            // If the real result's magnitude differs by >3 orders from ALL options → broken
            if (maxOptMag !== -Infinity && Math.abs(magnitude - maxOptMag) > 3) {
                console.warn(
                    `[ValidationPipeline] EXPONENTIATION MAGNITUDE MISMATCH: ` +
                    `${base}^${exponent} = 10^${magnitude}, but options are around 10^${maxOptMag}. ` +
                    `REJECTING question.`
                );
                return { action: 'reject', question: null };
            }
        } catch (e) {
            // Computation might overflow for extreme exponents
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
        this.fractionStage = new FractionVerificationStage();
        this.expMagnitudeStage = new ExponentiationMagnitudeStage();
        this.explanationOrderStage = new ExplanationStepOrderStage();
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

            // Stage 3.5: Fill-in-blank sanity check
            const fillSanity = this.fillBlankSanityStage.process(q);
            if (fillSanity.action === 'reject') return null;
            q = fillSanity.question;

            // Stage 4: Fraction verification
            const fracResult = this.fractionStage.process(q);
            if (fracResult.action === 'reject') return null;
            q = fracResult.question;

            // Stage 4.5: Exponentiation magnitude check
            const expResult = this.expMagnitudeStage.process(q);
            if (expResult.action === 'reject') return null;
            q = expResult.question;

            // Stage 5: Scientific notation cross-check
            const sciResult = this.sciNotationStage.process(q);
            if (sciResult.action === 'reject') return null;
            q = sciResult.question;

            // Stage 6: Ordering dependency validation
            const orderResult = this.orderingStage.process(q);
            if (orderResult.action === 'reject') return null;
            q = orderResult.question;

            // Stage 7: Structural verification gate (existing verifiers)
            const structResult = this.structuralStage.process(q);
            if (structResult.action === 'reject') return null;
            q = structResult.question;

            // Stage 8: Explanation step order validation
            const explResult = this.explanationOrderStage.process(q);
            q = explResult.question;

            return q;
        } catch (err) {
            console.warn(`[ValidationPipeline] Error (non-blocking): ${err.message}`);
            return q;
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