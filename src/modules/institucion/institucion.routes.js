import { Router } from 'express';

export function institucionRoutes({ institucionController }) {
    const router = Router();

    router.get('/cross-tenant', institucionController.listAllTenants);
    router.get('/user-institutions/:username', institucionController.lookupUserAcrossTenants);
    router.get('/', institucionController.list);
    router.get('/search', institucionController.search);
    router.get('/:id', institucionController.getById);
    router.post('/', institucionController.create);
    router.put('/:id', institucionController.update);
    router.delete('/:id', institucionController.delete);

    return router;
}
export default institucionRoutes;
