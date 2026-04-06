const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'shared', 'math', 'QuizMathValidator.js');

const lines = [];

// _tryFromExplanation
lines.push("");
lines.push("    // Explanation based validation");
lines.push("");
lines.push("    static _tryFromExplanation(text) {");
lines.push("        if (!text) return null;");
lines.push("        var patterns = [");
lines.push("            /(?:resultado?|respuesta|total|valor)\\s*(?:es|=|:)\\s*\\$?\\s*([\\d,]+\\.?\\d*)/i,");
lines.push("            /=\\s*\\$?\\s*([\\d,]+\\.?\\d*)\\s*$/im,");
lines.push("            /(?:obtenemos|da|encontramos|tenemos|queda)\\s+\\$?\\s*([\\d,]+\\.?\\d*)/i,");
lines.push("        ];");
lines.push("        for (var ei = 0; ei < patterns.length; ei++) {");
lines.push("            var m = text.match(patterns[ei]);");
lines.push("            if (m) {");
lines.push("                var val = QuizMathValidator._parseDecimal(m[1]);");
lines.push("                if (val && val.isFinite()) return { value: val, fromExplanation: true };");
lines.push("            }");
lines.push("        }");
lines.push("        return null;");
lines.push("    }");

// _findClosestOption
lines.push("");
lines.push("    static _findClosestOption(options, value) {");
lines.push("        if (!options || !options.length || !value) return null;");
lines.push("        var bestIdx = -1, bestDiff = null;");
lines.push("        for (var fi = 0; fi < options.length; fi++) {");
lines.push("            var optStr = String(options[fi]).replace(/[^\\d.,-]/g, '');");
lines.push("            var opt = QuizMathValidator._parseDecimal(optStr);");
lines.push("            if (!opt) continue;");
lines.push("            var diff = value.minus(opt).abs();");
lines.push("            if (bestDiff === null || diff.lt(bestDiff)) {");
lines.push("                bestDiff = diff;");
lines.push("                bestIdx = fi;");
lines.push("            }");
lines.push("        }");
lines.push("        if (bestIdx === -1) return null;");
lines.push("        var optStr2 = String(options[bestIdx]).replace(/[^\\d.,-]/g, '');");
lines.push("        var bestOpt = QuizMathValidator._parseDecimal(optStr2);");
lines.push("        if (!bestOpt) return null;");
lines.push("        var relErr = value.isZero() ? bestDiff : bestDiff.div(value.abs());");
lines.push("        if (relErr.gt('0.01') && bestDiff.gt('0.5')) return null;");
lines.push("        return { index: bestIdx, value: bestOpt };");
lines.push("    }");

// Ordering helpers
lines.push("");
lines.push("    // Ordering Helpers");
lines.push("");
lines.push("    static fixOrderingQuestion(items, rawCorrectOrder) {");
lines.push("        if (!items || !items.length) return null;");
lines.push("        var numeric = [];");
lines.push("        for (var oi = 0; oi < items.length; oi++) {");
lines.push("            var d = QuizMathValidator._parseDecimal(String(items[oi]).replace(/[^\\d.,-]/g, ''));");
lines.push("            if (!d) return null;");
lines.push("            numeric.push({ original: items[oi], value: d, origIdx: oi });");
lines.push("        }");
lines.push("        var isDesc = false;");
lines.push("        if (typeof rawCorrectOrder === 'string') {");
lines.push("            isDesc = /descend|mayor\\s*a\\s*menor|de\\s*mayor/i.test(rawCorrectOrder);");
lines.push("        } else if (Array.isArray(rawCorrectOrder) && rawCorrectOrder.length >= 2) {");
lines.push("            var first = QuizMathValidator._parseDecimal(String(rawCorrectOrder[0]).replace(/[^\\d.,-]/g, ''));");
lines.push("            var last = QuizMathValidator._parseDecimal(String(rawCorrectOrder[rawCorrectOrder.length - 1]).replace(/[^\\d.,-]/g, ''));");
lines.push("            if (first && last) isDesc = first.gt(last);");
lines.push("        }");
lines.push("        var sorted = numeric.slice().sort(function(a, b) { return isDesc ? b.value.cmp(a.value) : a.value.cmp(b.value); });");
lines.push("        return sorted.map(function(s) { return s.original; });");
lines.push("    }");

lines.push("");
lines.push("    static buildOrderingExplanation(correctSequence, llmExplanation) {");
lines.push("        if (!correctSequence || !correctSequence.length) return llmExplanation || '';");
lines.push("        var isDesc = false;");
lines.push("        if (correctSequence.length >= 2) {");
lines.push("            var f = QuizMathValidator._parseDecimal(String(correctSequence[0]).replace(/[^\\d.,-]/g, ''));");
lines.push("            var l = QuizMathValidator._parseDecimal(String(correctSequence[correctSequence.length - 1]).replace(/[^\\d.,-]/g, ''));");
lines.push("            if (f && l) isDesc = f.gt(l);");
lines.push("        }");
lines.push("        var direction = isDesc ? 'descendente (mayor a menor)' : 'ascendente (menor a mayor)';");
lines.push("        var explanation = 'El orden correcto ' + direction + ' es: ' + correctSequence.join(' > ');");
lines.push("        return explanation;");
lines.push("    }");

lines.push("");
lines.push("    static _stripOrderingClaims(text) {");
lines.push("        if (!text) return text;");
lines.push("        return text");
lines.push("            .replace(/(?:el\\s+)?orden\\s+(?:correcto|es|ser\\xeda)[^.]*\\./gi, '')");
lines.push("            .replace(/(?:de\\s+)?(?:mayor|menor)\\s+a\\s+(?:mayor|menor)[^.]*\\./gi, '')");
lines.push("            .replace(/\\s{2,}/g, ' ')");
lines.push("            .trim();");
lines.push("    }");

// Close class and export
lines.push("");
lines.push("}");
lines.push("");
lines.push("export default QuizMathValidator;");
lines.push("");

fs.appendFileSync(filePath, lines.join('\n'), 'utf8');
console.log('Part 3 written OK, lines:', lines.length);
