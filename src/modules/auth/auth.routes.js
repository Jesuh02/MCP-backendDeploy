import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.js';
import { authRateLimiter } from '../../shared/middleware/GranularRateLimiters.js';
import { registerSchema, loginSchema, refreshTokenSchema, changePasswordSchema, googleLoginSchema, checkPasswordSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema } from './auth.schemas.js';

export function authRoutes({ authController }) {
    const router = Router();

    router.post('/register', authRateLimiter, validate(registerSchema), authController.register);
    router.post('/check-password', authRateLimiter, validate(checkPasswordSchema), authController.checkPassword);
    router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
    router.post('/google', authRateLimiter, validate(googleLoginSchema), authController.googleLogin);
    router.post('/refresh-token', validate(refreshTokenSchema), authController.refreshToken);
    router.post('/change-password', validate(changePasswordSchema), authController.changePassword);

    // Password recovery (public — no auth required)
    router.post('/forgot-password', authRateLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
    router.post('/verify-reset-code', authRateLimiter, validate(verifyResetCodeSchema), authController.verifyResetCode);
    router.post('/reset-password', authRateLimiter, validate(resetPasswordSchema), authController.resetPassword);

    // Cross-tenant: searches ALL tenant databases in parallel
    router.post('/cross-tenant-login', authRateLimiter, validate(loginSchema), authController.crossTenantLogin);
    router.post('/cross-tenant-google', authRateLimiter, validate(googleLoginSchema), authController.crossTenantGoogleLogin);

    return router;
}
export default authRoutes;

