import { Result } from "../../shared/Result.js";
import ExcelJS from "exceljs";

// ─── Design tokens ──────────────────────────────────────────────────────────
const BRAND_COLOR    = "1E3A5F"; // deep navy header
const ACCENT_COLOR   = "2E86AB"; // accent blue for metadata row
const HEADER_FONT    = "FFFFFF"; // white text in headers
const ROW_ODD        = "EAF2FB"; // light blue tint  – odd rows
const ROW_EVEN       = "FFFFFF"; // white             – even rows
const BORDER_COLOR   = "B0C4D8"; // subtle steel-blue border
const TITLE_COLOR    = "1E3A5F"; // dark navy for report title
const META_BG        = "F0F4F8"; // very light blue metadata background

/**
 * Returns a thin border side descriptor.
 * @param {string} color hex without #
 */
function border(color = BORDER_COLOR) {
    return { style: "thin", color: { argb: `FF${color}` } };
}

/**
 * Applies a complete thin-border box to a cell.
 */
function applyBorder(cell, color = BORDER_COLOR) {
    cell.border = {
        top:    border(color),
        left:   border(color),
        bottom: border(color),
        right:  border(color),
    };
}

/**
 * Formats a column header key to Title Case with spaces.
 * e.g. "first_name" → "First Name", "courseId" → "Course Id"
 */
function formatHeader(key) {
    return String(key)
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Infers a best-fit column width from header label and row data.
 */
function inferColWidth(header, rows, colKey) {
    const maxDataLen = rows.reduce((max, row) => {
        const val = row[colKey];
        if (val == null) return max;
        return Math.max(max, String(val).length);
    }, 0);
    return Math.min(Math.max(header.length + 2, maxDataLen + 2, 12), 50);
}

export class ExcelDomainService {
    constructor({ mcpService, fileStoragePort }) {
        this.mcpService = mcpService;
        this.fileStoragePort = fileStoragePort;
    }

    async generateFromQuery({ query, userId, username, userRoles }) {
        let result;
        try {
            result = await this.mcpService.processQueryToData(query, userId, { username, userRoles });
        } catch (e) {
            try {
                result = await this.mcpService.processQuery(query);
            } catch (fallbackErr) {
                return Result.fail(`Error obteniendo datos: ${fallbackErr.message}`);
            }
        }

        if (!result) return Result.fail("No se obtuvo ningún resultado de la consulta");

        let dataToExport;
        try {
            dataToExport = this._extractData(result);
        } catch (err) {
            return Result.fail(`Error procesando estructura de datos: ${err.message}`);
        }

        if (!dataToExport || dataToExport.length === 0) {
            dataToExport = dataToExport || [];
        }

        try {
            const excelBuffer = await this._buildStyledWorkbook({
                data: dataToExport,
                sheetTitle: "Reporte",
                query,
                username,
                generatedAt: new Date(),
            });

            const timestamp = Date.now();
            const filename = `reports/excel_export_${userId || "anon"}_${timestamp}.xlsx`;

            const uploadResult = await this.fileStoragePort.uploadFile(
                excelBuffer,
                filename,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );

            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;

            return Result.ok({
                url: publicUrl,
                rows: dataToExport.length,
                filename,
                data: dataToExport,
            });
        } catch (uploadErr) {
            return Result.fail(`Error subiendo archivo: ${uploadErr.message}`);
        }
    }

    /**
     * Builds and uploads an Excel file from pre-fetched row data.
     * Use this when the caller already has the exact rows (e.g. from rawQueryData
     * returned by LLMDomainService.processPrompt) to avoid a second DB round-trip
     * that could return a different row count.
     *
     * @param {{ data: object[], userId: number|string, username?: string, query?: string }} params
     * @returns {Promise<Result>}
     */
    async buildFromRawData({ data, userId, username, query = '' }) {
        if (!Array.isArray(data) || data.length === 0) {
            return Result.fail('No hay datos para exportar en el Excel.');
        }
        try {
            const excelBuffer = await this._buildStyledWorkbook({
                data,
                sheetTitle: "Reporte",
                query,
                username,
                generatedAt: new Date(),
            });

            const timestamp = Date.now();
            const filename = `reports/excel_export_${userId || "anon"}_${timestamp}.xlsx`;

            const uploadResult = await this.fileStoragePort.uploadFile(
                excelBuffer,
                filename,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );

            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;

            return Result.ok({
                url: publicUrl,
                rows: data.length,
                filename,
                data,
            });
        } catch (uploadErr) {
            return Result.fail(`Error subiendo archivo: ${uploadErr.message}`);
        }
    }

    async uploadFile({ buffer, originalname, mimetype, size, userId }) {
        try {
            const timestamp = Date.now();
            const safeName = originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
            const objectKey = `uploads/${userId || "anon"}/${timestamp}_${safeName}`;

            const uploadResult = await this.fileStoragePort.uploadFile(buffer, objectKey, mimetype);
            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;

            return Result.ok({
                url: publicUrl,
                filename: originalname,
                size,
                mimetype,
            });
        } catch (err) {
            return Result.fail(`Error subiendo archivo: ${err.message}`);
        }
    }

    // ─── Professional workbook builder ────────────────────────────────────────

    /**
     * Builds a fully styled .xlsx workbook and returns it as a Buffer.
     *
     * Layout (rows):
     *  Row 1   → merged report title (branded)
     *  Row 2   → metadata: generated by, date, total rows
     *  Row 3   → blank spacer
     *  Row 4   → column headers (dark navy + white bold)
     *  Row 5+  → data rows (alternating light-blue / white)
     *  Last    → summary footer
     */
    async _buildStyledWorkbook({ data, sheetTitle, query, username, generatedAt }) {
        const workbook = new ExcelJS.Workbook();
        workbook.creator   = "CourseV Platform";
        workbook.lastModifiedBy = username || "Sistema";
        workbook.created   = generatedAt;
        workbook.modified  = generatedAt;
        workbook.properties.date1904 = false;

        const sheet = workbook.addWorksheet(sheetTitle, {
            pageSetup: {
                paperSize: 9, // A4
                orientation: "landscape",
                fitToPage: true,
                fitToWidth: 1,
                fitToHeight: 0,
                margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
            },
            headerFooter: {
                oddHeader: `&C&"Calibri,Bold"&14CourseV — ${sheetTitle}`,
                oddFooter:  "&LGenerado: " + generatedAt.toLocaleDateString("es-ES") + "&R&P de &N",
            },
        });

        // ── Handle empty data ─────────────────────────────────────────────────
        if (data.length === 0) {
            sheet.mergeCells("A1:D3");
            const cell = sheet.getCell("A1");
            cell.value = "No se encontraron resultados para la consulta solicitada.";
            cell.font       = { name: "Calibri", size: 12, italic: true, color: { argb: "FF6B7280" } };
            cell.alignment  = { vertical: "middle", horizontal: "center", wrapText: true };
            cell.fill       = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${META_BG}` } };
            sheet.getColumn("A").width = 60;
            return workbook.xlsx.writeBuffer();
        }

        const keys    = Object.keys(data[0]);
        const headers = keys.map(formatHeader);
        const colCount = keys.length;

        // ── Row 1 — Report title ──────────────────────────────────────────────
        const lastCol = sheet.getColumn(colCount).letter;
        sheet.mergeCells(`A1:${lastCol}1`);
        const titleCell = sheet.getCell("A1");
        titleCell.value     = `Reporte: ${sheetTitle}`;
        titleCell.font      = { name: "Calibri", bold: true, size: 16, color: { argb: `FF${HEADER_FONT}` } };
        titleCell.alignment = { vertical: "middle", horizontal: "center" };
        titleCell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BRAND_COLOR}` } };
        sheet.getRow(1).height = 34;

        // ── Row 2 — Metadata ──────────────────────────────────────────────────
        sheet.mergeCells(`A2:${lastCol}2`);
        const metaCell  = sheet.getCell("A2");
        const dateStr   = generatedAt.toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" });
        metaCell.value  = `Generado por: ${username || "Sistema"}   |   Fecha: ${dateStr}   |   Total de registros: ${data.length}`;
        metaCell.font   = { name: "Calibri", size: 10, italic: true, color: { argb: `FF${TITLE_COLOR}` } };
        metaCell.alignment = { vertical: "middle", horizontal: "center" };
        metaCell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${META_BG}` } };
        sheet.getRow(2).height = 22;

        // ── Row 3 — Spacer ────────────────────────────────────────────────────
        sheet.getRow(3).height = 6;

        // ── Row 4 — Column headers ────────────────────────────────────────────
        const headerRow = sheet.getRow(4);
        headers.forEach((label, i) => {
            const cell = headerRow.getCell(i + 1);
            cell.value     = label;
            cell.font      = { name: "Calibri", bold: true, size: 11, color: { argb: `FF${HEADER_FONT}` } };
            cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
            cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BRAND_COLOR}` } };
            applyBorder(cell, BRAND_COLOR);
        });
        headerRow.height = 26;

        // Enable autofilter on the header row
        sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: colCount } };

        // Freeze panes so title + header stay visible while scrolling
        sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 4, activeCell: "A5" }];

        // ── Rows 5+ — Data ────────────────────────────────────────────────────
        data.forEach((rowObj, rowIndex) => {
            const excelRow = sheet.getRow(5 + rowIndex);
            const isOdd    = rowIndex % 2 === 0;
            const rowBg    = isOdd ? ROW_ODD : ROW_EVEN;

            keys.forEach((key, colIndex) => {
                const cell = excelRow.getCell(colIndex + 1);
                const raw  = rowObj[key];

                // Smart value typing
                if (raw == null) {
                    cell.value = "";
                } else if (typeof raw === "number") {
                    cell.value  = raw;
                    // Format percentages and large integers nicely
                    if (String(key).toLowerCase().includes("porcent") || String(key).toLowerCase().includes("percent")) {
                        cell.numFmt = "0.00%";
                        cell.value  = raw / 100;
                    } else if (Number.isInteger(raw)) {
                        cell.numFmt = "#,##0";
                    } else {
                        cell.numFmt = "#,##0.00";
                    }
                } else if (raw instanceof Date) {
                    cell.value  = raw;
                    cell.numFmt = "dd/mm/yyyy hh:mm";
                } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
                    // ISO date strings → real date
                    cell.value  = new Date(raw);
                    cell.numFmt = "dd/mm/yyyy hh:mm";
                } else {
                    cell.value = raw;
                }

                cell.font      = { name: "Calibri", size: 10 };
                cell.alignment = { vertical: "middle", horizontal: typeof raw === "number" ? "right" : "left", wrapText: false };
                cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${rowBg}` } };
                applyBorder(cell);
            });

            excelRow.height = 20;
        });

        // ── Footer row — summary ──────────────────────────────────────────────
        const footerRowNum = 5 + data.length;
        sheet.mergeCells(`A${footerRowNum}:${lastCol}${footerRowNum}`);
        const footerCell    = sheet.getCell(`A${footerRowNum}`);
        footerCell.value    = `Total: ${data.length} registro${data.length !== 1 ? "s" : ""}`;
        footerCell.font     = { name: "Calibri", bold: true, size: 10, color: { argb: `FF${HEADER_FONT}` } };
        footerCell.alignment = { vertical: "middle", horizontal: "right" };
        footerCell.fill     = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ACCENT_COLOR}` } };
        sheet.getRow(footerRowNum).height = 22;

        // ── Column widths ─────────────────────────────────────────────────────
        keys.forEach((key, i) => {
            const col = sheet.getColumn(i + 1);
            col.width = inferColWidth(headers[i], data, key);
        });

        return workbook.xlsx.writeBuffer();
    }

    /**
     * Builds an Excel Buffer from pre-fetched row data without uploading to storage.
     * Used for email attachments.
     * @param {object[]} data
     * @param {string} [query]
     * @param {string} [username]
     * @returns {Promise<Buffer>}
     */
    async buildBuffer(data, query = '', username = 'Sistema') {
        return this._buildStyledWorkbook({
            data: Array.isArray(data) ? data : [],
            sheetTitle: 'Reporte',
            query,
            username,
            generatedAt: new Date(),
        });
    }

    // ─── Data extraction (unchanged logic) ────────────────────────────────────

    _extractData(result) {
        if (!result) return [];
        if (Array.isArray(result)) return result;

        const data = result.getValue ? result.getValue() : result;
        if (Array.isArray(data)) return data;

        if (!data || typeof data !== "object") return [];
        if (data.error) return [];

        if (Array.isArray(data.data)) return data.data;

        if (data.data && typeof data.data === "object") {
            if (data.data.error) return [];

            if (data.data.samples && typeof data.data.samples === "object") {
                const rows = Object.values(data.data.samples).flat().filter(Boolean);
                if (rows.length > 0) return rows;
            }

            if (data.data.metrics && typeof data.data.metrics === "object" && Object.keys(data.data.metrics).length > 0) {
                return Object.entries(data.data.metrics).map(([key, value]) => ({ Metric: key, Value: value }));
            }
        }

        if (Array.isArray(data.metrics)) {
            return data.metrics.map(([key, value]) => ({ Metric: key, Value: value }));
        }

        const METADATA_KEYS = new Set(["sqlScript", "schema", "sql", "iterations", "warning", "fallback", "error", "message", "hint", "reason"]);
        const arrayProp = Object.entries(data)
            .filter(([k]) => !METADATA_KEYS.has(k))
            .map(([, v]) => v)
            .find(v => Array.isArray(v));
        if (arrayProp) return arrayProp;

        if (Object.keys(data).some(k => METADATA_KEYS.has(k))) return [];

        return [data];
    }
}

export default ExcelDomainService;


