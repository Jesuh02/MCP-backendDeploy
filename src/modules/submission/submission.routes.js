import { Router } from 'express';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

export function submissionRoutes({ submissionController }) {
    const router = Router();

    router.get('/my', submissionController.getMySubmissions);
    router.get('/task/:taskId', submissionController.getByTask);
    router.get('/task/:taskId/student', submissionController.getByUserAndTask);
    router.get('/course/:courseId', submissionController.getByCourse);
    router.get('/:id', submissionController.getById);
    router.get('/:id/file', submissionController.getFile);
    router.post('/upload', upload.single('file'), submissionController.uploadFile);
    router.post('/content', submissionController.getSubmissionContent);
    router.post('/', submissionController.submit);
    router.put('/:id/grade', submissionController.grade);
    router.delete('/:id', submissionController.delete);

    return router;
}
export default submissionRoutes;

