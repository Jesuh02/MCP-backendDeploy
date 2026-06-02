#!/usr/bin/env node
/**
 * sign_language_confusion_matrix.mjs
 * ----------------------------------
 * Genera SIEMPRE una matriz de confusión para el reconocedor de lengua
 * de señas. Cubre las 5 clases que el VLM soporta:
 *   letter | number | word | phrase | sentence
 *
 * Modo de uso:
 *   node scripts/sign_language_confusion_matrix.mjs
 *   node scripts/sign_language_confusion_matrix.mjs --samples ./eval_samples
 *   node scripts/sign_language_confusion_matrix.mjs --no-open
 *
 * Modos:
 *   1) Real: si se pasa --samples <dir>, cada subcarpeta es una clase con
 *      archivos .jpg/.png que se mandan al endpoint /sign-language/recognize-clip.
 *      Cada clip puede ser un archivo individual (1 frame) o una subcarpeta
 *      con varios frames numerados.
 *   2) Demo (default): genera predicciones sintéticas a partir de una matriz
 *      de probabilidad realista por clase (basada en los kinds del VLM) para
 *      que la gráfica se vea SIEMPRE, incluso sin dataset etiquetado.
 *
 * Salida:
 *   • Matriz ASCII en la terminal (con accuracy global y por clase).
 *   • HTML interactivo (Chart.js heatmap) en
 *     out/sign_language_confusion_matrix.html, que se abre automáticamente
 *     en el navegador salvo que se use --no-open.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLASSES = ['letter', 'number', 'word', 'phrase', 'sentence'];

const args = process.argv.slice(2);
const samplesDir = pickArg('--samples');
const apiBase = pickArg('--api') || process.env.SIGN_LANGUAGE_API_BASE || 'http://localhost:3000/api/v1';
const noOpen = args.includes('--no-open');
const samplesPerClassDemo = Number(pickArg('--demo-n')) || 40;
const pipelineMode = normalizePipelineMode(pickArg('--pipeline'));

function pickArg(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// ── 1. Obtener pares (yTrue, yPred) ──────────────────────────────────────
async function collectPredictions() {
    if (samplesDir) {
    console.log(`[CM] Modo REAL: evaluando pipeline "${pipelineMode}" contra ${apiBase}.`);
        return await predictFromSamples(samplesDir);
    }
  console.log(`[CM] Modo DEMO: usando predicciones sintéticas para pipeline "${pipelineMode}" (sin --samples).`);
    return generateSyntheticPredictions(samplesPerClassDemo);
}

/**
 * Lee samples/<clase>/<clip>.(jpg|png) o samples/<clase>/<clipdir>/*.jpg
 * y los evalúa contra el pipeline solicitado:
 *   camera   -> replica el flujo híbrido del frontend
 *   vlm      -> fuerza /sign-language/recognize-clip
 *   alphabet -> fuerza /sign-language/session/:id/frame
 */
async function predictFromSamples(root) {
    const pairs = [];
    if (!fs.existsSync(root)) {
        throw new Error(`Directorio de samples no existe: ${root}`);
    }
    for (const cls of CLASSES) {
        const dir = path.join(root, cls);
        if (!fs.existsSync(dir)) {
            console.warn(`[CM] (skip) sin samples para clase "${cls}"`);
            continue;
        }
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const full = path.join(dir, entry);
            const stat = fs.statSync(full);
            const frames = stat.isDirectory()
                ? fs.readdirSync(full)
                    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
                    .sort()
                    .map((f) => fs.readFileSync(path.join(full, f)).toString('base64'))
                : (/\.(jpe?g|png|webp)$/i.test(entry)
                    ? [fs.readFileSync(full).toString('base64')]
                    : []);
            if (!frames.length) continue;
            try {
              const predicted = await predictSample(frames);
                pairs.push({ yTrue: cls, yPred: predicted });
              console.log(`[CM] ${cls.padEnd(8)} → ${predicted.padEnd(8)}  (${pipelineMode.padEnd(8)} | ${entry})`);
            } catch (err) {
                console.warn(`[CM] fallo en ${entry}:`, err?.message || err);
            }
        }
    }
    if (!pairs.length) throw new Error('No se recogió ninguna predicción.');
    return pairs;
}

  async function predictSample(frames) {
    switch (pipelineMode) {
      case 'vlm':
        return await predictWithVlm(frames);
      case 'alphabet':
        return await predictWithAlphabet(frames[frames.length - 1]);
      case 'camera':
      default:
        return frames.length > 1
          ? await predictWithVlm(frames)
          : await predictWithAlphabet(frames[0]);
    }
  }

  async function predictWithVlm(frames) {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/sign-language/recognize-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames }),
    });
    const json = await parseJsonResponse(res);
    return json?.data?.kind || 'unknown';
  }

  async function predictWithAlphabet(imageBase64) {
    const sessionId = `cm-${randomUUID()}`;
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/sign-language/session/${sessionId}/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, minConfidence: 0 }),
    });
    const json = await parseJsonResponse(res);
    return json?.data?.detection?.label ? 'letter' : 'unknown';
  }

  async function parseJsonResponse(res) {
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`Respuesta no JSON (${res.status}): ${raw.slice(0, 160)}`);
    }
    if (!res.ok) {
      const msg = json?.error?.message || raw.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return json;
  }

  function normalizePipelineMode(value) {
    if (value === 'vlm' || value === 'clip') return 'vlm';
    if (value === 'alphabet' || value === 'frame') return 'alphabet';
    return 'camera';
  }

/**
 * Predicciones sintéticas: cada clase tiene una distribución realista
 * sobre el resto. La diagonal es alta (modelo razonable) pero hay
 * confusiones plausibles (letter↔number, word↔phrase, phrase↔sentence).
 */
function generateSyntheticPredictions(n) {
    const dist = {
        letter:   { letter: 0.82, number: 0.10, word: 0.05, phrase: 0.02, sentence: 0.00, unknown: 0.01 },
        number:   { letter: 0.08, number: 0.84, word: 0.04, phrase: 0.02, sentence: 0.01, unknown: 0.01 },
        word:     { letter: 0.04, number: 0.02, word: 0.78, phrase: 0.12, sentence: 0.03, unknown: 0.01 },
        phrase:   { letter: 0.01, number: 0.01, word: 0.10, phrase: 0.72, sentence: 0.14, unknown: 0.02 },
        sentence: { letter: 0.00, number: 0.01, word: 0.04, phrase: 0.18, sentence: 0.75, unknown: 0.02 },
    };
    const pairs = [];
    for (const cls of CLASSES) {
        for (let i = 0; i < n; i++) {
            pairs.push({ yTrue: cls, yPred: sampleFromDist(dist[cls]) });
        }
    }
    return pairs;
}

function sampleFromDist(d) {
    const r = Math.random();
    let acc = 0;
    for (const [k, p] of Object.entries(d)) {
        acc += p;
        if (r <= acc) return k;
    }
    return Object.keys(d).pop();
}

// ── 2. Construir matriz ──────────────────────────────────────────────────
function buildMatrix(pairs) {
    const labels = [...CLASSES, 'unknown'];
    const idx = Object.fromEntries(labels.map((l, i) => [l, i]));
    const m = labels.map(() => labels.map(() => 0));
    for (const { yTrue, yPred } of pairs) {
        const i = idx[yTrue];
        const j = idx[yPred] ?? idx.unknown;
        if (i != null) m[i][j]++;
    }
    return { labels, matrix: m };
}

function metrics(labels, matrix) {
    const total = matrix.flat().reduce((a, b) => a + b, 0);
    let correct = 0;
    const perClass = labels.map((lbl, i) => {
        const tp = matrix[i][i];
        const rowSum = matrix[i].reduce((a, b) => a + b, 0);
        const colSum = matrix.reduce((a, row) => a + row[i], 0);
        correct += tp;
        const recall = rowSum ? tp / rowSum : 0;
        const precision = colSum ? tp / colSum : 0;
        const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
        return { label: lbl, support: rowSum, precision, recall, f1 };
    });
    return { accuracy: total ? correct / total : 0, total, perClass };
}

// ── 3. Render ASCII ──────────────────────────────────────────────────────
function renderAscii(labels, matrix, stats) {
    const colW = Math.max(8, ...labels.map((l) => l.length + 1));
    const head = 'true \\ pred'.padEnd(12) + labels.map((l) => l.padStart(colW)).join('');
    const rows = labels.map((lbl, i) => {
        const cells = matrix[i].map((v, j) => {
            const txt = String(v).padStart(colW);
            return i === j && v > 0 ? `\x1b[32m${txt}\x1b[0m` : txt;
        }).join('');
        return lbl.padEnd(12) + cells;
    });
    const sep = '─'.repeat(head.length);
    console.log('\n' + sep);
    console.log('  MATRIZ DE CONFUSIÓN — Sign Language (LSC)');
    console.log(sep);
    console.log(head);
    console.log(sep);
    rows.forEach((r) => console.log(r));
    console.log(sep);
    console.log(`  Accuracy global : ${(stats.accuracy * 100).toFixed(2)} %   (n=${stats.total})`);
    console.log(sep);
    console.log('  clase       support   precision   recall    f1');
    console.log('  ' + '-'.repeat(50));
    stats.perClass.forEach((c) => {
        console.log(
            '  ' + c.label.padEnd(10) +
            String(c.support).padStart(7) +
            (c.precision * 100).toFixed(1).padStart(11) + ' %' +
            (c.recall * 100).toFixed(1).padStart(8) + ' %' +
            (c.f1 * 100).toFixed(1).padStart(8) + ' %',
        );
    });
    console.log(sep + '\n');
}

// ── 4. Render HTML (Chart.js heatmap) ────────────────────────────────────
function renderHtml(labels, matrix, stats, outFile) {
    // Normalización por fila para colorear
    const norm = matrix.map((row) => {
        const s = row.reduce((a, b) => a + b, 0) || 1;
        return row.map((v) => v / s);
    });
    const points = [];
    for (let i = 0; i < labels.length; i++) {
        for (let j = 0; j < labels.length; j++) {
            points.push({ x: labels[j], y: labels[i], v: matrix[i][j], n: norm[i][j] });
        }
    }
    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Matriz de Confusión — Sign Language</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0d0d10; color:#e8e8ec; margin:0; padding:32px; }
  h1 { font-weight:600; font-size:22px; margin:0 0 4px; }
  p.sub { color:#9aa0aa; margin:0 0 24px; font-size:13px; }
  .wrap { max-width:1100px; margin:0 auto; }
  .grid { display:grid; grid-template-columns: 1fr 320px; gap:24px; align-items:start; }
  canvas#cm { background:#15151b; border:1px solid #23232b; border-radius:14px; padding:12px; }
  .card { background:#15151b; border:1px solid #23232b; border-radius:14px; padding:18px; }
  .acc { font-size:34px; font-weight:700; color:#00D4FF; }
  table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
  th,td { padding:6px 8px; text-align:right; border-bottom:1px solid #23232b; }
  th:first-child, td:first-child { text-align:left; }
  th { color:#9aa0aa; font-weight:500; }
  .legend { font-size:12px; color:#9aa0aa; margin-top:8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Matriz de Confusión — Lengua de Señas</h1>
  <p class="sub">Pipeline: ${pipelineMode} · Clases: letter · number · word · phrase · sentence · unknown · ${stats.total} muestras</p>
  <div class="grid">
    <div>
      <canvas id="cm" width="700" height="600"></canvas>
      <div class="legend">Intensidad = proporción por fila (true). Número = conteo absoluto.</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#9aa0aa;">Accuracy global</div>
      <div class="acc">${(stats.accuracy * 100).toFixed(2)} %</div>
      <table>
        <thead><tr><th>Clase</th><th>n</th><th>P</th><th>R</th><th>F1</th></tr></thead>
        <tbody>
          ${stats.perClass.map((c) => `
            <tr>
              <td>${c.label}</td>
              <td>${c.support}</td>
              <td>${(c.precision * 100).toFixed(1)}</td>
              <td>${(c.recall * 100).toFixed(1)}</td>
              <td>${(c.f1 * 100).toFixed(1)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-matrix@2.0.1/dist/chartjs-chart-matrix.min.js"></script>
<script>
  const labels = ${JSON.stringify(labels)};
  const data = ${JSON.stringify(points)};
  const ctx = document.getElementById('cm').getContext('2d');
  new Chart(ctx, {
    type: 'matrix',
    data: {
      datasets: [{
        label: 'Confusión',
        data,
        backgroundColor(c) {
          const v = c.dataset.data[c.dataIndex].n;
          const alpha = 0.15 + v * 0.85;
          return 'rgba(0, 212, 255,' + alpha + ')';
        },
        borderColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        width: ({ chart }) => (chart.chartArea || {}).width / labels.length - 2,
        height: ({ chart }) => (chart.chartArea || {}).height / labels.length - 2,
      }],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => 'true=' + items[0].raw.y + '  pred=' + items[0].raw.x,
            label: (item) => 'n=' + item.raw.v + '  (' + (item.raw.n * 100).toFixed(1) + ' %)',
          },
        },
      },
      scales: {
        x: { type: 'category', labels, position: 'top', title: { display: true, text: 'Predicción', color:'#9aa0aa' }, ticks: { color:'#e8e8ec' }, grid: { color:'#23232b' } },
        y: { type: 'category', labels: labels.slice().reverse(), title: { display: true, text: 'Verdadero', color:'#9aa0aa' }, ticks: { color:'#e8e8ec' }, grid: { color:'#23232b' } },
      },
    },
    plugins: [{
      id: 'cellText',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        meta.data.forEach((el, i) => {
          const d = chart.data.datasets[0].data[i];
          ctx.save();
          ctx.fillStyle = d.n > 0.5 ? '#001218' : '#e8e8ec';
          ctx.font = '600 12px -apple-system, Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(d.v, el.x, el.y);
          ctx.restore();
        });
      },
    }],
  });
</script>
</body>
</html>`;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');
}

function openInBrowser(file) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', file] : [file];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
    const pairs = await collectPredictions();
    const { labels, matrix } = buildMatrix(pairs);
    const stats = metrics(labels, matrix);
    renderAscii(labels, matrix, stats);

    const outFile = path.resolve(__dirname, '..', 'out', 'sign_language_confusion_matrix.html');
    renderHtml(labels, matrix, stats, outFile);
    console.log(`[CM] HTML escrito en: ${outFile}`);
    if (!noOpen) {
        openInBrowser(outFile);
        console.log('[CM] Abriendo en el navegador…');
    }
})().catch((err) => {
    console.error('[CM] Error:', err?.message || err);
    process.exit(1);
});
