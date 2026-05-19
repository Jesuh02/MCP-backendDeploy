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
