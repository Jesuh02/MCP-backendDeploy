import { Router } from 'express';
import multer from 'multer';
import { validate } from '../../shared/middleware/validate.js';
import { updateProfileSchema, registerFCMTokenSchema, assignRoleSchema, searchUsersSchema } from './user.schemas.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export function userRoutes({ userController, requireRoles }) {
    const router = Router();

    router.get('/me', userController.getProfile);
    router.put('/me', validate(updateProfileSchema), userController.updateProfile);
    router.post('/me/avatar', upload.single('avatar'), userController.uploadAvatar);
    router.get('/search', validate(searchUsersSchema, 'query'), userController.search);
    router.get('/by-ids', userController.getByIds);
    router.get('/by-email/:email', userController.getByEmail);
    router.get('/by-username/:username', userController.getByUsername);
    router.get('/:id', userController.getById);
    router.post('/fcm-token', validate(registerFCMTokenSchema), userController.registerFCMToken);
    router.delete('/fcm-token', userController.removeFCMToken);
    router.post('/:id/role', requireRoles(3, 4), validate(assignRoleSchema), userController.assignRole);

    // Admin — user activation management
    router.get('/admin/list', requireRoles(3, 4), userController.listAll);
    router.post('/:id/deactivate', requireRoles(3, 4), userController.deactivateUser);
    router.post('/:id/activate', requireRoles(3, 4), userController.activateUser);
    router.post('/admin/process-expired-courses', requireRoles(3, 4), userController.processExpiredCourseUsers);

    return router;
}
export default userRoutes;