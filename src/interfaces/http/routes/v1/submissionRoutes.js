import { Router } from 'express';

export function submissionRoutes({ submissionController }) {
    const router = Router();

    router.get('/my', submissionController.getMySubmissions);
    router.get('/task/:taskId', submissionController.getByTask);
    router.get('/task/:taskId/student', submissionController.getByUserAndTask);
    router.get('/course/:courseId', submissionController.getByCourse);
    router.get('/:id', submissionController.getById);
    router.post('/', submissionController.submit);
    router.put('/:id/grade', submissionController.grade);
    router.delete('/:id', submissionController.delete);

    return router;
}
export default submissionRoutes;