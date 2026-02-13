import { Router } from 'express';
import multer from 'multer';

const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'video') {
            const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska'];
            cb(null, allowed.includes(file.mimetype));
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
    router.get('/search', videoController.search);
    router.get('/by-courses', videoController.getByCourseIds);
    router.get('/creator/:username', videoController.getByCreator);
    router.get('/course/:courseId', videoController.getByCourse);
    router.get('/:id', videoController.getById);
    router.get('/:id/signed-url', videoController.getSignedUrl);
    router.post('/upload-url', videoController.getUploadUrl);
    router.post('/upload', videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), videoController.uploadAndCreate);
    router.post('/', videoController.create);
    router.put('/:id', videoController.update);
    router.delete('/:id', videoController.delete);

    return router;
}
export default videoRoutes;