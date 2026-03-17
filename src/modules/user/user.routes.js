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

    // Admin — user activation management
    router.get('/admin/list', requireRoles(3), userController.listAll);
    router.post('/:id/deactivate', requireRoles(3), userController.deactivateUser);
    router.post('/:id/activate', requireRoles(3), userController.activateUser);
    router.post('/admin/process-expired-courses', requireRoles(3), userController.processExpiredCourseUsers);

    return router;
}
export default userRoutes;