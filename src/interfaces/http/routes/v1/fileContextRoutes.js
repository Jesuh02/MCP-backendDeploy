import { Router } from 'express';

export function fileContextRoutes({ fileContextController }) {
    const router = Router();

    router.get('/', fileContextController.list);
    router.get('/submission/:submissionId', fileContextController.getBySubmission);
    router.get('/:id', fileContextController.getById);
    router.post('/', fileContextController.create);
    router.delete('/:id', fileContextController.delete);

    return router;
}
export default fileContextRoutes;