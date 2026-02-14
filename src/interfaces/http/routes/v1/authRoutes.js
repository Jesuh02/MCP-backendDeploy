import { Router } from 'express';

export function authRoutes({ authController }) {
    const router = Router();

    router.post('/register', authController.register);
    router.post('/login', authController.login);
    router.post('/refresh-token', authController.refreshToken);
    router.post('/change-password', authController.changePassword); // Protected by global auth middleware

    return router;
}
export default authRoutes;

