/**
 * @deprecated excelRoutes.js - DEPRECADO
 * Migrado a: src/interfaces/http/routes/v1/excelRoutes.js
 * Controller: ExcelController.js
 * Servicio: ExcelDomainService.js
 * 
 * Este archivo se mantiene �nicamente por compatibilidad con index.legacy.js.
 */
import { Router } from 'express';
const router = Router();

// Legacy route stub kept only for backward compatibility with index.legacy.js.
// The real implementation lives under /api/v1/excel in src/interfaces/http/routes/v1.
// Any requests hitting this router will receive a 410 Gone status with a hint.
router.post('/generate-excel', (req, res) => {
    res.status(410).json({
        success: false,
        error: 'La ruta /excel/generate-excel está obsoleta. Usa /api/v1/excel/generate-excel en su lugar.'
    });
});
router.post('/upload', (req, res) => {
    res.status(410).json({
        success: false,
        error: 'La ruta /excel/upload está obsoleta. Usa /api/v1/excel/upload en su lugar.'
    });
});

export default router;


