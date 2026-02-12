/**
 * ExcelController — Controlador HTTP para generación de reportes Excel.
 *
 * Recibe requests HTTP, valida parámetros, delega al ExcelDomainService,
 * y devuelve respuestas estandarizadas { success, data }.
 */

import { ValidationError } from '../../../shared/errors/index.js';

export class ExcelController {
    /**
     * @param {Object} deps
     * @param {import('../../../domain/services/ExcelDomainService.js').ExcelDomainService} deps.excelService
     */
    constructor({ excelService }) {
        this.excelService = excelService;
    }

    /**
     * POST /generate-excel
     * Genera un Excel a partir de una consulta en lenguaje natural.
     */
    generateExcel = async(req, res, next) => {
        try {
            const { query, userId } = req.body;

            if (!query || typeof query !== 'string' || !query.trim()) {
                return next(new ValidationError('Se requiere el campo "query"'));
            }

            const effectiveUserId = userId || req.user ?.userId ?.toString() || 'anon';

            console.log(`📊 Generating Excel for query: "${query}" (User: ${effectiveUserId})`);

            const result = await this.excelService.generateFromQuery({
                query: query.trim(),
                userId: effectiveUserId,
            });

            if (result.isFail()) {
                return res.status(400).json({ success: false, error: result.getError() });
            }

            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /upload
     * Sube un archivo genérico a R2 Storage.
     * Requiere multipart/form-data con campo 'file'.
     */
    upload = async(req, res, next) => {
        try {
            if (!req.file) {
                return next(new ValidationError('Se requiere un archivo'));
            }

            const userId = req.body.userId || req.user ?.userId ?.toString() || 'anon';

            const result = await this.excelService.uploadFile({
                buffer: req.file.buffer,
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
                userId,
            });

            if (result.isFail()) {
                return res.status(400).json({ success: false, error: result.getError() });
            }

            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };
}

export default ExcelController;