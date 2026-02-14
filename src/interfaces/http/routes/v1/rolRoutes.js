import { Router } from 'express';

export function rolRoutes({ rolController }) {
    const router = Router();

    // Roles
    router.get('/', rolController.listRoles);
    router.get('/:id', rolController.getRolById);

    // User roles
    router.get('/user/:userId', rolController.getUserRoleIds);
    router.get('/user/:userId/is-docente', rolController.isUserDocente);
    router.post('/user/:userId/promote-docente', rolController.promoteToDocente);
    router.post('/user/:userId/ensure-creator', rolController.ensureCreatorRole);
    router.post('/sync-creator-roles', rolController.syncCreatorRoles);

    // Recursos
    router.get('/recursos/all', rolController.listRecursos);
    router.get('/recursos/by-rol/:rolId', rolController.getRecursosByRol);

    // Rol-Recursos mapping
    router.get('/rol-recursos/all', rolController.listRolRecursos);

    return router;
}
export default rolRoutes;

