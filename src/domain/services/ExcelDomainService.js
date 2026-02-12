/**
 * ExcelDomainService — Servicio de dominio para generación de reportes Excel.
 *
 * Principio SRP: encapsula la lógica de:
 *   1. Obtener datos desde MCPService (consulta en lenguaje natural → SQL → datos)
 *   2. Generar un archivo Excel (.xlsx) en memoria
 *   3. Subir el buffer resultante a R2 Storage
 *
 * Depende de puertos (interfaces), no de implementaciones concretas (DIP).
 */

import { Result } from '../../shared/Result.js';
import { createRequire } from 'module';

const require = createRequire(
    import.meta.url);
const xlsx = require('xlsx');

export class ExcelDomainService {
    /**
     * @param {Object} deps
     * @param {Object} deps.mcpService   - MCPService (legacy singleton, se inyecta como dependencia)
     * @param {Object} deps.fileStoragePort - R2StorageAdapter (puerto de almacenamiento)
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

            // ── 1. Obtener datos ──────────────────────────────────────
            let result;
            try {
                console.log(`⏱️ [${Date.now() - startTime}ms] Starting processQueryToData...`);
                result = await this.mcpService.processQueryToData(query, userId);
                console.log(`⏱️ [${Date.now() - startTime}ms] processQueryToData complete.`);
            } catch (e) {
                console.warn('⚠️ processQueryToData failed, falling back to processQuery:', e.message);


            } catch (fallbackErr) {
                result = await this.mcpService.processQuery(query);
































































































































export default ExcelDomainService;}    }        return [];        }            return [result.data];            if (arrayProp) return arrayProp;            const arrayProp = Object.values(result.data).find(v => Array.isArray(v));            }                return Array.isArray(result.data.data) ? result.data.data : [result.data.data];            if (result.data.data) {            }                }));                    Value: value,                    Metric: key,                return Object.entries(result.data.metrics).map(([key, value]) => ({            if (result.data.metrics) {        if (result.data && typeof result.data === 'object') {        }            return result.data;        if (Array.isArray(result.data)) {    _extractData(result) {     */     * @private     * que puede venir en diferentes formatos.     * Extrae un array plano de datos desde la respuesta de MCPService,    /**    // ── Helpers privados ──────────────────────────────────────    }        }            return Result.fail(`Error subiendo archivo: ${err.message}`);        } catch (err) {            });                mimetype,                size,                filename: originalname,                url: publicUrl,            return Result.ok({            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;            const uploadResult = await this.fileStoragePort.uploadFile(buffer, objectKey, mimetype);        try {        console.log(`📤 Uploading ${originalname} (${size} bytes) to ${objectKey}`);        const objectKey = `uploads/${userId || 'anon'}/${timestamp}_${safeName}`;        const safeName = originalname.replace(/[^a-zA-Z0-9.-]/g, '_');        const timestamp = Date.now();    async uploadFile({ buffer, originalname, mimetype, size, userId }) {     */     * @returns {Promise<Result<{url: string, filename: string, size: number, mimetype: string}>>}     * @param {string} [params.userId] - ID del usuario     * @param {number} params.size     - Tamaño en bytes     * @param {string} params.mimetype - Tipo MIME     * @param {string} params.originalname - Nombre original     * @param {Buffer} params.buffer   - Contenido del archivo     * @param {Object} params     *     * Sube un archivo genérico a R2 (para la ruta /upload).    /**    }        }            return Result.fail(`Error subiendo archivo: ${uploadErr.message}`);        } catch (uploadErr) {            });                filename,                rows: dataToExport.length,                url: publicUrl,            return Result.ok({            console.log(`⏱️ [${Date.now() - startTime}ms] Upload complete: ${publicUrl}`);            const publicUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;            // uploadFile puede devolver un Result o directamente la URL            );                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',                filename,                excelBuffer,            const uploadResult = await this.fileStoragePort.uploadFile(        try {        console.log(`📤 Uploading Excel to ${filename}...`);        const filename = `reports/excel_export_${userId || 'anon'}_${timestamp}.xlsx`;        const timestamp = Date.now();        // ── 4. Subir a R2 ─────────────────────────────────────────        console.log(`⏱️ [${Date.now() - startTime}ms] Excel buffer created (${excelBuffer.length} bytes). Uploading...`);        const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });        xlsx.utils.book_append_sheet(wb, ws, 'Results');        ws['!cols'] = colWidths;        }));            wch: Math.max(key.length, 15),        const colWidths = Object.keys(dataToExport[0] || {}).map(key => ({        // Auto-width columns        const ws = xlsx.utils.json_to_sheet(dataToExport);        const wb = xlsx.utils.book_new();        // ── 3. Generar Excel ──────────────────────────────────────        console.log(`⏱️ [${Date.now() - startTime}ms] Starting Excel generation...`);        console.log(`✅ Data retrieved: ${dataToExport.length} rows`);        }            return Result.fail('No se encontraron datos para esta consulta');        if (!dataToExport || dataToExport.length === 0) {        const dataToExport = this._extractData(result);                // ── 2. Normalizar estructura de datos ─────────────────────            }
                return Result.fail(result.message || result.error);
                if (result.error) {}
                return Result.fail(result);
                if (typeof result === 'string') {}
                try {

                }
                return Result.fail(`Error obteniendo datos: ${fallbackErr.message}`);
            } catch (fallbackErr) { result = await this.mcpService.processQuery(query); try {