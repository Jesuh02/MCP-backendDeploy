import { Router } from 'express';

export function videoRoutes({ videoController }) {
    const router = Router();

    router.get('/', videoController.list);
    router.get('/search', videoController.search);
    router.get('/by-courses', videoController.getByCourseIds);
    router.get('/creator/:username', videoController.getByCreator);
    router.get('/course/:courseId', videoController.getByCourse);
    router.get('/:id', videoController.getById);
    router.get('/:id/signed-url', videoController.getSignedUrl);
    router.post('/signed-url-by-key', videoController.getSignedUrlByKey);
    router.post('/signed-url-by-key', videoController.getSignedUrlByKey);
    router.post('/upload-url', videoController.getUploadUrl);
    router.post('/', videoController.create);
    router.put('/:id', videoController.update);
    router.delete('/:id', videoController.delete);

    return router;
}
export default videoRoutes;