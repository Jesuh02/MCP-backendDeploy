import { Router } from 'express';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

export function storageRoutes({ storageController }) {
    const router = Router();

    router.post('/upload-url', storageController.getUploadUrl);
    router.post('/upload', upload.single('file'), storageController.upload);
    router.get('/download', storageController.getDownloadUrl);
    router.get('/list', storageController.listFiles);
    router.delete('/', storageController.delete);

    return router;
}
export default storageRoutes;

