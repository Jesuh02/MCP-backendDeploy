import { Router } from 'express';

export function personaRoutes({ personaController }) {
    const router = Router();

    router.get('/', personaController.list);
    router.get('/search', personaController.search);
    router.get('/by-identificacion/:identificacion', personaController.getByIdentificacion);
    router.get('/:id', personaController.getById);
    router.post('/', personaController.create);
    router.put('/:id', personaController.update);
    router.delete('/:id', personaController.delete);

    return router;
}
export default personaRoutes;

