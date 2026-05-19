/**
 * PdfDomainService — Genera reportes PDF con gráficas y tablas de datos.
 *
 * Flujo:
 *   1. Obtiene datos vía MCP (o acepta rawData ya procesada)
 *   2. Genera imagen de gráfica vía QuickChart.io (sin dependencias nativas)
 *   3. Construye PDF con pdfkit (título, gráfica, tabla)
 *   4. Sube PDF a R2 vía fileStoragePort
 *   5. Retorna { url (PDF), chartUrl (imagen PNG), rows }
 *
 * La URL chartUrl es pública y puede enviarse directamente como imagen en WhatsApp.
 */
import PDFDocument from 'pdfkit';
import { Result } from '../../shared/Result.js';

const QUICKCHART_BASE = 'https://quickchart.io/chart';

const CHART_COLORS = [
    'rgba(54, 162, 235, 0.85)',
    'rgba(255, 99, 132, 0.85)',
    'rgba(75, 192, 192, 0.85)',
    'rgba(255, 159, 64, 0.85)',
    'rgba(153, 102, 255, 0.85)',
    'rgba(255, 205, 86, 0.85)',
];

const BRAND_DARK  = '#1e3a5f';
const ROW_ODD     = '#f0f7ff';
const ROW_EVEN    = '#ffffff';
const FOOTER_BG   = '#dbeafe';
const META_COLOR  = '#4b5563';

export class PdfDomainService {
    /**
     * @param {{ mcpService: object, fileStoragePort: object }} deps
     */
    constructor({ mcpService, fileStoragePort }) {
        this.mcpService = mcpService;
        this.fileStoragePort = fileStoragePort;
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /**
     * Run an MCP query and produce a styled PDF report with a chart.
     * @param {{ query: string, userId: number|string, username?: string, userRoles?: number[], chartType?: string }} params
     * @returns {Promise<Result<{ url: string, chartUrl: string|null, rows: number }>>}
     */
    async generateFromQuery({ query, userId, username, userRoles, chartType = 'bar' }) {
        let result;
        try {
            result = await this.mcpService.processQueryToData(query, userId, { username, userRoles });
        } catch {
            try {
                result = await this.mcpService.processQuery(query);
            } catch (err) {
                return Result.fail(`Error obteniendo datos: ${err.message}`);
            }
        }

        if (!result) return Result.fail('No se obtuvo resultado de la consulta');

        const data = this._extractData(result);
        return this._buildAndUpload({ data, query, userId, username, chartType });
    }

    /**
     * Build a PDF from pre-fetched row data (e.g. rawQueryData from LLMDomainService).
     * @param {{ data: object[], userId: number|string, username?: string, query?: string, chartType?: string }} params
     * @returns {Promise<Result<{ url: string, chartUrl: string|null, rows: number }>>}
     */
    async buildFromRawData({ data, userId, username, query = '', chartType = 'bar' }) {
        if (!Array.isArray(data) || data.length === 0) {
            return Result.fail('No hay datos para exportar.');
        }
        return this._buildAndUpload({ data, query, userId, username, chartType });
    }

    /**
     * Genera un PDF de ANÁLISIS EJECUTIVO con:
     *   - Texto argumentativo generado por el LLM (secciones ## Markdown)
     *   - Múltiples gráficas automáticas (barra, doughnut, segunda métrica)
     *   - Tabla de datos paginada
     *
     * @param {{ data: object[], query?: string, analysisText?: string, userId: number|string, username?: string }} params
     * @returns {Promise<Result<{ url: string, chartUrls: string[], rows: number }>>}
     */
    async buildAnalyticalReport({ data, query = '', analysisText = '', userId, username }) {
        if (!Array.isArray(data) || data.length === 0) {
            return Result.fail('No hay datos para el análisis.');
        }
        try {
            const chartConfigs = this._buildAnalysisChartConfigs(data);
            const chartEntries = await Promise.all(
                chartConfigs.map(async (cfg) => {
                    const url = this._buildQuickChartUrl(cfg.config);
                    const buffer = await this._fetchBuffer(url).catch(e => {
                        console.warn(`[PdfService] chart fetch error (${cfg.label}):`, e.message);
                        return null;
                    });
                    return { buffer, label: cfg.label, url };
                }),
            );

            const pdfBuffer = await this._buildAnalyticsPdf({
                data,
                query,
                username,
                analysisText,
                chartEntries,
                generatedAt: new Date(),
            });

            const timestamp = Date.now();
            const filename = `reports/analysis_${userId || 'anon'}_${timestamp}.pdf`;
            const uploadResult = await this.fileStoragePort.uploadFile(pdfBuffer, filename, 'application/pdf');
            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;
            const chartUrls = chartEntries.filter(e => e.url).map(e => e.url);
            return Result.ok({ url: publicUrl, chartUrls, rows: data.length });
        } catch (err) {
            console.error('[PdfService] Error in buildAnalyticalReport:', err);
            return Result.fail(`Error generando análisis PDF: ${err.message}`);
        }
    }

    // ─── Internal orchestration ────────────────────────────────────────────────

    async _buildAndUpload({ data, query, userId, username, chartType }) {
        try {
            const chartConfig = this._buildChartConfig(data, chartType);
            const chartUrl    = chartConfig ? this._buildQuickChartUrl(chartConfig) : null;

            let chartImageBuffer = null;
            if (chartUrl) {
                chartImageBuffer = await this._fetchBuffer(chartUrl).catch(e => {
                    console.warn('[PdfService] Could not fetch chart image:', e.message);
                    return null;
                });
            }

            const pdfBuffer = await this._buildPdf({
                data,
                query,
                username,
                chartImageBuffer,
                generatedAt: new Date(),
            });

            const timestamp = Date.now();
            const filename  = `reports/pdf_export_${userId || 'anon'}_${timestamp}.pdf`;

            const uploadResult = await this.fileStoragePort.uploadFile(
                pdfBuffer,
                filename,
                'application/pdf',
            );

            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;

            return Result.ok({ url: publicUrl, chartUrl, rows: data.length });
        } catch (err) {
            console.error('[PdfService] Error in _buildAndUpload:', err);
            return Result.fail(`Error generando PDF: ${err.message}`);
        }
    }

    // ─── Chart helpers ─────────────────────────────────────────────────────────

    /**
     * Builds a Chart.js-compatible config from flat row data.
     * Auto-detects label column (first non-numeric) and up to 3 numeric value columns.
     */
    _buildChartConfig(data, chartType = 'bar') {
        if (!data || data.length === 0) return null;

        const keys = Object.keys(data[0]);
        if (keys.length === 0) return null;

        // Label column: first key whose values are non-numeric
        const labelKey = keys.find(k => {
            const s = data[0][k];
            return s !== null && s !== undefined && typeof s !== 'number';
        }) ?? keys[0];

        // Value columns: numeric keys (excluding label column), up to 3
        const valueKeys = keys.filter(k => k !== labelKey && data.some(r => typeof r[k] === 'number'));
        if (valueKeys.length === 0) return null;

        const MAX_LABELS = 15;
        const display    = data.slice(0, MAX_LABELS);
        const labels     = display.map(r => String(r[labelKey] ?? '').slice(0, 30));

        const datasets = valueKeys.slice(0, 3).map((key, i) => ({
            label: key,
            data: display.map(r => Number(r[key]) || 0),
            backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
            borderColor: CHART_COLORS[i % CHART_COLORS.length].replace('0.85', '1'),
            borderWidth: 1,
        }));

        // Use horizontal bars when labels are long (improves readability)
        const avgLen       = labels.reduce((s, l) => s + l.length, 0) / Math.max(labels.length, 1);
        const resolvedType = chartType === 'bar' && avgLen > 12 ? 'horizontalBar' : chartType;

        return {
            type: resolvedType,
            data: { labels, datasets },
            options: {
                plugins: {
                    legend: { display: valueKeys.length > 1, position: 'top' },
                    title:  { display: false },
                },
                ...(resolvedType !== 'pie' && resolvedType !== 'doughnut'
                    ? { scales: { yAxes: [{ ticks: { beginAtZero: true } }] } }
                    : {}),
            },
        };
    }

    /**
     * Genera 2–3 configuraciones de gráficas distintas para reportes de análisis:
     *   1. Barra / HorizontalBar — métrica principal
     *   2. Doughnut             — distribución porcentual
     *   3. Barra segunda métrica (si existe una segunda columna numérica)
     */
    _buildAnalysisChartConfigs(data) {
        if (!data || data.length === 0) return [];

        const keys     = Object.keys(data[0]);
        const labelKey = keys.find(k => {
            const s = data[0][k];
            return s !== null && s !== undefined && typeof s !== 'number';
        }) ?? keys[0];

        const valueKeys = keys.filter(k => k !== labelKey && data.some(r => typeof r[k] === 'number'));
        if (valueKeys.length === 0) return [];

        const MAX_LABELS = 12;
        const display    = data.slice(0, MAX_LABELS);
        const labels     = display.map(r => String(r[labelKey] ?? '').slice(0, 28));
        const avgLen     = labels.reduce((s, l) => s + l.length, 0) / Math.max(labels.length, 1);
        const mainType   = avgLen > 12 ? 'horizontalBar' : 'bar';
        const mainScales = { yAxes: [{ ticks: { beginAtZero: true } }] };

        const charts = [];

        // Chart 1: Barra principal
        charts.push({
            label: valueKeys[0],
            config: {
                type: mainType,
                data: {
                    labels,
                    datasets: [{
                        label: valueKeys[0],
                        data: display.map(r => Number(r[valueKeys[0]]) || 0),
                        backgroundColor: CHART_COLORS[0],
                        borderColor: CHART_COLORS[0].replace('0.85', '1'),
                        borderWidth: 1,
                    }],
                },
                options: {
                    plugins: {
                        legend: { display: false },
                        title: { display: true, text: valueKeys[0] },
                    },
                    scales: mainScales,
                },
            },
        });

        // Chart 2: Doughnut — distribución
        charts.push({
            label: `Distribución: ${valueKeys[0]}`,
            config: {
                type: 'doughnut',
                data: {
                    labels,
                    datasets: [{
                        data: display.map(r => Number(r[valueKeys[0]]) || 0),
                        backgroundColor: CHART_COLORS,
                    }],
                },
                options: {
                    plugins: {
                        legend: { display: true, position: 'right' },
                        title: { display: true, text: `Distribución: ${valueKeys[0]}` },
                    },
                },
            },
        });

        // Chart 3: Segunda métrica (si existe)
        if (valueKeys.length > 1) {
            charts.push({
                label: valueKeys[1],
                config: {
                    type: mainType,
                    data: {
                        labels,
                        datasets: [{
                            label: valueKeys[1],
                            data: display.map(r => Number(r[valueKeys[1]]) || 0),
                            backgroundColor: CHART_COLORS[2],
                            borderColor: CHART_COLORS[2].replace('0.85', '1'),
                            borderWidth: 1,
                        }],
                    },
                    options: {
                        plugins: {
                            legend: { display: false },
                            title: { display: true, text: valueKeys[1] },
                        },
                        scales: mainScales,
                    },
                },
            });
        }

        return charts;
    }

    /**
     * Returns a public QuickChart.io URL that renders the chart as a PNG image.
     * The URL itself can be sent as an image message in WhatsApp.
     */
    _buildQuickChartUrl(config) {
        const c = encodeURIComponent(JSON.stringify(config));
        return `${QUICKCHART_BASE}?c=${c}&width=600&height=320&backgroundColor=white&format=png`;
    }

    /** Fetches a URL and returns the response body as a Buffer. */
    async _fetchBuffer(url) {
        const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        return Buffer.from(await resp.arrayBuffer());
    }

    // ─── PDF builder ───────────────────────────────────────────────────────────

    /**
     * Generates a styled A4 PDF with:
     *   - Branded header bar
     *   - Metadata line (user, date, row count)
     *   - Embedded chart image (when available)
     *   - Paginated data table (max 100 rows)
     * @returns {Promise<Buffer>}
     */
    async _buildPdf({ data, query, username, chartImageBuffer, generatedAt }) {
        return new Promise((resolve, reject) => {
            const doc    = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
            const chunks = [];

            doc.on('data',  c => chunks.push(c));
            doc.on('end',   () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const pageW  = doc.page.width  - 80; // usable width (40px margin each side)
            const pageH  = doc.page.height;
            const dateStr = generatedAt.toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' });

            // ── Header bar ──────────────────────────────────────────────────────
            doc.rect(40, 40, pageW, 36).fill(BRAND_DARK);
            doc.fillColor('white').fontSize(14).font('Helvetica-Bold')
               .text('CourseV — Reporte', 48, 51, { width: pageW - 16, lineBreak: false });

            // ── Metadata ────────────────────────────────────────────────────────
            doc.fillColor(META_COLOR).fontSize(8).font('Helvetica')
               .text(
                   `Generado por: ${username || 'Sistema'}   |   Fecha: ${dateStr}   |   Total registros: ${data.length}`,
                   40, 84, { width: pageW },
               );

            let y = 100;

            // ── Query label ─────────────────────────────────────────────────────
            if (query) {
                doc.fillColor('#374151').fontSize(9).font('Helvetica-Oblique')
                   .text(`Consulta: ${query.slice(0, 250)}`, 40, y, { width: pageW });
                y = doc.y + 8;
            }

            // ── Chart image ─────────────────────────────────────────────────────
            if (chartImageBuffer) {
                try {
                    const imgH = 200;
                    doc.image(chartImageBuffer, 40, y, { width: pageW, height: imgH });
                    y += imgH + 14;
                } catch (e) {
                    console.warn('[PdfService] Could not embed chart image in PDF:', e.message);
                }
            }

            // ── Data table ──────────────────────────────────────────────────────
            if (data.length === 0) {
                doc.fillColor('#6b7280').fontSize(10).font('Helvetica-Oblique')
                   .text('No se encontraron datos para esta consulta.', 40, y, { width: pageW });
                doc.end();
                return;
            }

            const keys       = Object.keys(data[0]);
            const colCount   = Math.min(keys.length, 8); // cap at 8 columns for readability
            const visKeys    = keys.slice(0, colCount);
            const colW       = pageW / colCount;
            const ROW_H      = 18;
            const HEADER_H   = 22;

            const drawTableHeader = (yPos) => {
                doc.rect(40, yPos, pageW, HEADER_H).fill(BRAND_DARK);
                doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
                visKeys.forEach((k, i) => {
                    doc.text(String(k).slice(0, 20), 40 + i * colW + 4, yPos + 6, {
                        width: colW - 6,
                        lineBreak: false,
                        ellipsis: true,
                    });
                });
                return yPos + HEADER_H;
            };

            if (y + HEADER_H > pageH - 60) { doc.addPage(); y = 40; }
            y = drawTableHeader(y);

            const maxRows = Math.min(data.length, 100);
            for (let ri = 0; ri < maxRows; ri++) {
                if (y + ROW_H > pageH - 60) {
                    doc.addPage();
                    y = drawTableHeader(40);
                }

                doc.rect(40, y, pageW, ROW_H).fill(ri % 2 === 0 ? ROW_ODD : ROW_EVEN);
                doc.fillColor('#1f2937').fontSize(7.5).font('Helvetica');

                visKeys.forEach((k, i) => {
                    const val = data[ri][k];
                    const cell = val === null || val === undefined ? '' : String(val);
                    doc.text(cell.slice(0, 45), 40 + i * colW + 4, y + 4, {
                        width: colW - 6,
                        lineBreak: false,
                        ellipsis: true,
                    });
                });

                y += ROW_H;
            }

            // ── Footer row ──────────────────────────────────────────────────────
            if (y + ROW_H <= pageH - 40) {
                doc.rect(40, y, pageW, ROW_H).fill(FOOTER_BG);
                doc.fillColor(BRAND_DARK).fontSize(8).font('Helvetica-Bold')
                   .text(
                       `Total: ${data.length} registro${data.length !== 1 ? 's' : ''}`,
                       40, y + 4,
                       { width: pageW - 4, align: 'right' },
                   );
            }

            doc.end();
        });
    }

    // ─── Analytics PDF builder ─────────────────────────────────────────────────

    /**
     * Renderiza texto de análisis con Markdown básico en el PDF.
     * Soporta: ## secciones, ### subsecciones, - / * listas, 1. numerados, texto normal.
     * @returns {number} Nueva coordenada Y.
     */
    _renderAnalysisText(doc, text, startY, pageW, pageH) {
        const lines = text.split('\n');
        let y = startY;

        for (const rawLine of lines) {
            const line = rawLine.trimEnd();

            if (y + 20 > pageH - 60) { doc.addPage(); y = 40; }

            if (line.startsWith('## ')) {
                if (y > startY + 4) y += 4;
                const txt = line.replace(/^##\s*/, '');
                doc.rect(40, y, pageW, 18).fill('#dbeafe');
                doc.fillColor(BRAND_DARK).fontSize(10).font('Helvetica-Bold')
                   .text(txt, 44, y + 4, { width: pageW - 8, lineBreak: false });
                y += 22;
            } else if (line.startsWith('### ')) {
                if (y > startY + 4) y += 2;
                const txt = line.replace(/^###\s*/, '');
                doc.fillColor('#1e40af').fontSize(9.5).font('Helvetica-Bold')
                   .text(txt, 40, y, { width: pageW });
                y = doc.y + 2;
            } else if (/^\d+\.\s/.test(line)) {
                const txt = line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
                doc.fillColor('#1f2937').fontSize(9).font('Helvetica')
                   .text(txt, 46, y, { width: pageW - 6 });
                y = doc.y + 1;
            } else if (line.startsWith('- ') || line.startsWith('* ')) {
                const txt = line.replace(/^[-*]\s*/, '')
                    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
                doc.fillColor('#374151').fontSize(9).font('Helvetica')
                   .text(`• ${txt}`, 48, y, { width: pageW - 8 });
                y = doc.y + 1;
            } else if (line.trim() === '') {
                y += 5;
            } else {
                const txt = line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
                doc.fillColor('#1f2937').fontSize(9).font('Helvetica')
                   .text(txt, 40, y, { width: pageW });
                y = doc.y + 2;
            }
        }
        return y + 8;
    }

    /**
     * Construye un PDF de análisis ejecutivo con texto argumentativo y múltiples gráficas.
     * Layout: Header → Metadata → Texto análisis → Gráficas (2 por fila) → Tabla de datos.
     * @returns {Promise<Buffer>}
     */
    async _buildAnalyticsPdf({ data, query, username, analysisText, chartEntries, generatedAt }) {
        return new Promise((resolve, reject) => {
            const doc    = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
            const chunks = [];

            doc.on('data',  c => chunks.push(c));
            doc.on('end',   () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const pageW  = doc.page.width  - 80;
            const pageH  = doc.page.height;
            const dateStr = generatedAt.toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' });

            // ── Header bar ──────────────────────────────────────────────────────
            doc.rect(40, 40, pageW, 36).fill(BRAND_DARK);
            doc.fillColor('white').fontSize(14).font('Helvetica-Bold')
               .text('CourseV — Análisis Ejecutivo', 48, 51, { width: pageW - 16, lineBreak: false });

            // ── Metadata ────────────────────────────────────────────────────────
            doc.fillColor(META_COLOR).fontSize(8).font('Helvetica')
               .text(
                   `Generado por: ${username || 'Sistema'}   |   Fecha: ${dateStr}   |   Total registros: ${data.length}`,
                   40, 84, { width: pageW },
               );

            let y = 100;

            // ── Query label ─────────────────────────────────────────────────────
            if (query) {
                doc.fillColor('#374151').fontSize(9).font('Helvetica-Oblique')
                   .text(`Consulta: ${query.slice(0, 250)}`, 40, y, { width: pageW });
                y = doc.y + 8;
            }

            // ── Texto de análisis (LLM-generated) ──────────────────────────────
            if (analysisText && analysisText.trim()) {
                y = this._renderAnalysisText(doc, analysisText.trim(), y, pageW, pageH);
            }

            // ── Gráficas (2 por fila) ───────────────────────────────────────────
            const validCharts = chartEntries.filter(c => c && c.buffer);
            if (validCharts.length > 0) {
                if (y + 20 > pageH - 60) { doc.addPage(); y = 40; }
                doc.rect(40, y, pageW, 18).fill(BRAND_DARK);
                doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
                   .text('Gráficas', 44, y + 4, { width: pageW - 8, lineBreak: false });
                y += 22;

                if (validCharts.length === 1) {
                    const chartH = 200;
                    if (y + chartH > pageH - 60) { doc.addPage(); y = 40; }
                    try {
                        doc.image(validCharts[0].buffer, 40, y, { width: pageW, height: chartH });
                        y += chartH + 12;
                    } catch (e) { console.warn('[PdfService] chart embed error:', e.message); }
                } else {
                    const chartW = (pageW - 8) / 2;
                    const chartH = 170;
                    for (let i = 0; i < validCharts.length; i++) {
                        const col = i % 2;
                        if (col === 0 && y + chartH > pageH - 60) { doc.addPage(); y = 40; }
                        try {
                            doc.image(validCharts[i].buffer, 40 + col * (chartW + 8), y, { width: chartW, height: chartH });
                            if (col === 1 || i === validCharts.length - 1) { y += chartH + 12; }
                        } catch (e) { console.warn('[PdfService] chart embed error:', e.message); }
                    }
                }
            }

            // ── Tabla de datos ──────────────────────────────────────────────────
            if (data.length > 0) {
                if (y + 30 > pageH - 60) { doc.addPage(); y = 40; }
                doc.rect(40, y, pageW, 18).fill(BRAND_DARK);
                doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
                   .text('Datos del análisis', 44, y + 4, { width: pageW - 8, lineBreak: false });
                y += 22;

                const keys     = Object.keys(data[0]);
                const colCount = Math.min(keys.length, 8);
                const visKeys  = keys.slice(0, colCount);
                const colW     = pageW / colCount;
                const ROW_H    = 18;
                const HEADER_H = 22;

                const drawHeader = (yPos) => {
                    doc.rect(40, yPos, pageW, HEADER_H).fill('#374151');
                    doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
                    visKeys.forEach((k, i) => {
                        doc.text(String(k).slice(0, 20), 40 + i * colW + 4, yPos + 6, {
                            width: colW - 6, lineBreak: false, ellipsis: true,
                        });
                    });
                    return yPos + HEADER_H;
                };

                if (y + HEADER_H > pageH - 60) { doc.addPage(); y = 40; }
                y = drawHeader(y);

                const maxRows = Math.min(data.length, 100);
                for (let ri = 0; ri < maxRows; ri++) {
                    if (y + ROW_H > pageH - 60) { doc.addPage(); y = drawHeader(40); }
                    doc.rect(40, y, pageW, ROW_H).fill(ri % 2 === 0 ? ROW_ODD : ROW_EVEN);
                    doc.fillColor('#1f2937').fontSize(7.5).font('Helvetica');
                    visKeys.forEach((k, i) => {
                        const val  = data[ri][k];
                        const cell = val === null || val === undefined ? '' : String(val);
                        doc.text(cell.slice(0, 45), 40 + i * colW + 4, y + 4, {
                            width: colW - 6, lineBreak: false, ellipsis: true,
                        });
                    });
                    y += ROW_H;
                }

                if (y + ROW_H <= pageH - 40) {
                    doc.rect(40, y, pageW, ROW_H).fill(FOOTER_BG);
                    doc.fillColor(BRAND_DARK).fontSize(8).font('Helvetica-Bold')
                       .text(
                           `Total: ${data.length} registro${data.length !== 1 ? 's' : ''}`,
                           40, y + 4, { width: pageW - 4, align: 'right' },
                       );
                }
            }

            doc.end();
        });
    }

    // ─── Data extraction (mirrors ExcelDomainService._extractData) ─────────────

    _extractData(result) {
        if (!result) return [];
        if (Array.isArray(result)) return result;

        const data = result.getValue ? result.getValue() : result;
        if (Array.isArray(data)) return data;
        if (!data || typeof data !== 'object') return [];
        if (data.error) return [];
        if (Array.isArray(data.data)) return data.data;

        if (data.data?.samples) {
            const rows = Object.values(data.data.samples).flat().filter(Boolean);
            if (rows.length > 0) return rows;
        }

        if (data.data?.metrics && Object.keys(data.data.metrics).length > 0) {
            return Object.entries(data.data.metrics).map(([k, v]) => ({ Métrica: k, Valor: v }));
        }

        if (Array.isArray(data.metrics)) {
            return data.metrics.map(([k, v]) => ({ Métrica: k, Valor: v }));
        }

        const META = new Set(['sqlScript', 'schema', 'sql', 'iterations', 'warning', 'fallback', 'error', 'message', 'hint', 'reason']);
        const arr = Object.entries(data)
            .filter(([k]) => !META.has(k))
            .map(([, v]) => v)
            .find(v => Array.isArray(v));
        if (arr) return arr;
        if (Object.keys(data).some(k => META.has(k))) return [];
        return [data];
    }
}

export default PdfDomainService;
