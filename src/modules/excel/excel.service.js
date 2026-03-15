import { Result } from "../../shared/Result.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const xlsx = require("xlsx");

export class ExcelDomainService {
    constructor({ mcpService, fileStoragePort }) {
        this.mcpService = mcpService;
        this.fileStoragePort = fileStoragePort;
    }

    async generateFromQuery({ query, userId }) {
        let result;
        try {
            result = await this.mcpService.processQueryToData(query, userId);
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
            const wb = xlsx.utils.book_new();
            let ws;

            if (dataToExport.length === 0) {
                const msg = `No se encontraron filas para la consulta:\n${query}`;
                ws = xlsx.utils.aoa_to_sheet([[msg]]);
                ws["!cols"] = [{ wch: Math.max(msg.length, 15) }];
            } else {
                ws = xlsx.utils.json_to_sheet(dataToExport);

                const colWidths = Object.keys(dataToExport[0] || {}).map(key => ({
                    wch: Math.max(key.length, 15)
                }));
                ws["!cols"] = colWidths;
            }

            xlsx.utils.book_append_sheet(wb, ws, "Results");
            const excelBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

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
                filename
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


