import { Router } from 'express';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export function userRoutes({ userController, requireRoles }) {
    const router = Router();

    router.get('/me', userController.getProfile);
    router.put('/me', userController.updateProfile);
    router.post('/me/avatar', upload.single('avatar'), userController.uploadAvatar);
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