import { Router } from 'express';

export function rolRoutes({ rolController }) {
    const router = Router();

    // Roles
    router.get('/', rolController.listRoles);
    router.get('/:id', rolController.getRolById);

    // User roles
    router.get('/user/:userId', rolController.getUserRoles);
    router.get('/user/:userId/is-docente', rolController.isDocente);
    router.post('/user/:userId/promote-docente', rolController.promoteToDocente);

    // Recursos
    router.get('/recursos/all', rolController.listRecursos);
    router.get('/recursos/by-rol/:rolId', rolController.getRecursosByRol);

    // Rol-Recursos mapping
    router.get('/rol-recursos/all', rolController.listRolRecursos);
    router.get('/rol-recursos/by-rol/:rolId', rolController.getRolRecursosByRol);

    return router;
}
export default rolRoutes;