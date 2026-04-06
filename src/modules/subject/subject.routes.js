import { Router } from 'express';

export function subjectRoutes({ subjectController }) {
    const router = Router();

    router.get('/', subjectController.list);
    router.get('/course/:courseId', subjectController.getByCourse);
    router.get('/creator/:userId', subjectController.getByCreator);
    router.get('/:id', subjectController.getById);
    router.post('/', subjectController.create);
    router.put('/:id', subjectController.update);
    router.delete('/:id', subjectController.delete);

    // Subject collaborators
    router.get('/:id/collaborators', subjectController.getSubjectCollaborators);
    router.post('/:id/collaborators', subjectController.addSubjectCollaborator);
    router.put('/:id/collaborators/sync', subjectController.syncSubjectCollaborators);
    router.delete('/:id/collaborators/:userId', subjectController.removeSubjectCollaborator);

    return router;
}
export default subjectRoutes;
