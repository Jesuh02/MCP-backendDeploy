import { Router } from 'express';

export function periodRoutes({ periodController, requireRoles }) {
    const router = Router();

    // Docente/Admin: cerrar periodo (snapshot + reset)
    router.post('/', requireRoles(2, 3, 4), periodController.closePeriod);

    // Cualquier usuario autenticado: listar periodos de una materia
    router.get('/subject/:subjectId', periodController.listBySubject);

    // Cualquier usuario autenticado: listar periodos de un curso
    router.get('/course/:courseId', periodController.listByCourse);

    // Cualquier usuario autenticado: obtener detalle de un periodo
    router.get('/:periodId', periodController.getById);

    // Docente/Admin: modificar notas dentro de un periodo
    router.put('/:periodId/grades', requireRoles(2, 3, 4), periodController.updateGrades);

    // Docente/Admin: eliminar periodo
    router.delete('/:periodId', requireRoles(3, 4), periodController.deletePeriod);

    return router;
}

export default periodRoutes;
