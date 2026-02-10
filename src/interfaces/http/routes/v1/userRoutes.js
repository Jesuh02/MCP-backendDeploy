import { Router } from 'express';

export function userRoutes({ userController, requireRoles }) {
    const router = Router();

    router.get('/me', userController.getProfile);
    router.put('/me', userController.updateProfile);
    router.get('/search', userController.search);
    router.get('/by-ids', userController.getByIds);
    router.get('/by-email/:email', userController.getByEmail);
    router.get('/by-username/:username', userController.getByUsername);
    router.get('/:id', userController.getById);
    router.post('/fcm-token', userController.registerFCMToken);
    router.post('/:id/role', requireRoles(3), userController.assignRole); // Admin only

    return router;
}
export default userRoutes;