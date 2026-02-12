/**
 * excelRoutes — Rutas v1 para generación de reportes Excel y upload de archivos.
 */

import { Router } from 'express';
import multer from 'multer';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

export function excelRoutes({ excelController }) {
    const router = Router();

    router.post('/generate-excel', excelController.generateExcel);
    router.post('/upload', upload.single('file'), excelController.upload);

    return router;
}

export default excelRoutes;
