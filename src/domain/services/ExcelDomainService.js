/**
 * ExcelDomainService  Servicio de dominio para generación de reportes Excel.
 *
 * Principio SRP: encapsula la lógica de:
 *   1. Obtener datos desde MCPService (consulta en lenguaje natural  SQL  datos)
 *   2. Generar un archivo Excel (.xlsx) en memoria
 *   3. Subir el buffer resultante a R2 Storage
 *
 * Depende de puertos (interfaces), no de implementaciones concretas (DIP).
 */

import { Result } from "../../shared/Result.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const xlsx = require("xlsx");

export class ExcelDomainService {
    /**
     * @param {Object} deps
     * @param {Object} deps.mcpService   - MCPService
     * @param {Object} deps.fileStoragePort - R2StorageAdapter
     */
    constructor({ mcpService, fileStoragePort }) {
        this.mcpService = mcpService;
        this.fileStoragePort = fileStoragePort;
    }

    /**
     * Genera un Excel a partir de una consulta en lenguaje natural.
     *
     * @param {Object} params
     * @param {string} params.query  - Consulta del usuario (e.g. "todos los usuarios")
     * @param {string} [params.userId] - ID del usuario que solicita el reporte
     * @returns {Promise<Result<{url: string, rows: number, filename: string}>>}
     */
    async generateFromQuery({ query, userId }) {
        const startTime = Date.now();

        //  1. Obtener datos 
        let result;
        try {
            console.log("Starting processQueryToData...");
            result = await this.mcpService.processQueryToData(query, userId);
        } catch (e) {
            console.warn("processQueryToData failed, falling back to processQuery:", e.message);
            try {
                result = await this.mcpService.processQuery(query);
            } catch (fallbackErr) {
                return Result.fail(`Error obteniendo datos: ${fallbackErr.message}`);
            }
        }

        //  2. Normalizar estructura de datos 
        if (!result) return Result.fail("No se obtuvo ningún resultado de la consulta");
        
        let dataToExport;
        try {
            dataToExport = this._extractData(result);
        } catch (err) {
            return Result.fail(`Error procesando estructura de datos: ${err.message}`);
        }

        if (!dataToExport || dataToExport.length === 0) {
            return Result.fail("No se encontraron datos para esta consulta");
        }

        //  3. Generar Excel 
        try {
            const wb = xlsx.utils.book_new();
            const ws = xlsx.utils.json_to_sheet(dataToExport);

            // Auto-width columns
            const colWidths = Object.keys(dataToExport[0] || {}).map(key => ({
                wch: Math.max(key.length, 15)
            }));
            ws["!cols"] = colWidths;

            xlsx.utils.book_append_sheet(wb, ws, "Results");
            const excelBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

            //  4. Subir a R2 
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

    /**
     * Sube un archivo genérico a R2 (para la ruta /upload).
     */
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

    /**
     * Extrae un array plano de datos desde la respuesta de MCPService.
     * @private
     */
    _extractData(result) {
        if (!result) return [];
        if (Array.isArray(result)) return result;
        const data = result.getValue ? result.getValue() : result;
        if (Array.isArray(data)) return data;
        if (data && typeof data === "object") {
            if (Array.isArray(data.data)) return data.data;
            if (Array.isArray(data.metrics)) {
                return data.metrics.map(([key, value]) => ({ Metric: key, Value: value }));
            }
            const arrayProp = Object.values(data).find(v => Array.isArray(v));
            if (arrayProp) return arrayProp;
            return [data];
        }
        return [];
    }
}

export default ExcelDomainService;


