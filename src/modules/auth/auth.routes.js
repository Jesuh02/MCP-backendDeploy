import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.js';
import { authRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';
import { registerSchema, loginSchema, refreshTokenSchema, changePasswordSchema, googleLoginSchema } from './auth.schemas.js';

export function authRoutes({ authController }) {
    const router = Router();

    router.post('/register', authRateLimiter, validate(registerSchema), authController.register);
    router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
    router.post('/google', authRateLimiter, validate(googleLoginSchema), authController.googleLogin);
    router.post('/refresh-token', validate(refreshTokenSchema), authController.refreshToken);
    router.post('/change-password', validate(changePasswordSchema), authController.changePassword);

    return router;
}
export default authRoutes;

