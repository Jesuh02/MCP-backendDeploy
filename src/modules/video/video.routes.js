import { Router } from 'express';
import multer from 'multer';

function getFileExtension(filename = '') {
    const raw = filename.split('.').pop();
    return raw ? raw.toLowerCase() : '';
}

function isAllowedVideoFile(file) {
    const mime = String(file.mimetype || '').toLowerCase();
    const extension = getFileExtension(file.originalname || '');
    const allowedMimes = new Set([
        'video/mp4',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'video/x-matroska',
        'video/3gpp',
        'video/3gpp2',
        'video/mpeg',
        'application/mp4',
        'application/octet-stream',
    ]);
    const allowedExtensions = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', '3gp', '3g2', 'mpeg', 'mpg', 'm4v']);

    return mime.startsWith('video/') || allowedMimes.has(mime) || allowedExtensions.has(extension);
}

const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'video') {
            cb(null, isAllowedVideoFile(file));
        } else if (file.fieldname === 'thumbnail') {
            const allowed = ['image/jpeg', 'image/png', 'image/webp'];
            cb(null, allowed.includes(file.mimetype));
        } else {
            cb(null, false);
        }
    },
});

export function videoRoutes({ videoController }) {
    const router = Router();

    router.get('/', videoController.list);
    router.get('/changes', videoController.changes);
    router.get('/search', videoController.search);
    router.get('/by-courses', videoController.getByCourseIds);
    router.get('/creator/:username', videoController.getByCreator);
    router.get('/course/:courseId', videoController.getByCourse);
    router.get('/:id', videoController.getById);
    router.get('/:id/signed-url', videoController.getSignedUrl);
    router.post('/batch-signed-urls', videoController.batchSignedUrls);
    router.post('/upload-url', videoController.getUploadUrl);
    router.post('/upload', videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), videoController.uploadAndCreate);
    router.post('/', videoController.create);
    router.put('/:id', videoController.update);
    router.delete('/:id', videoController.delete);

    return router;
}
export default videoRoutes;

