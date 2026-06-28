import { registerSchema, loginSchema, refreshTokenSchema, sessionLinkSchema, changePasswordSchema, googleLoginSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema } from './auth.schemas.js';
import { ValidationError, ConflictError } from '../../shared/errors/index.js';
import { runInTenantContext, getTenantClient, TENANT_CONFIGS } from '../../config/tenantRegistry.js';
import { verifyGoogleIdToken } from './infrastructure/google-token.verifier.js';

/**
 * Sets HttpOnly cookies for the access and refresh tokens.
 * SameSite=None + Secure is required for cross-origin requests (web on coursev.workers.dev → railway.app).
 */
function _setAuthCookies(res, accessToken, refreshToken) {
    const base = { httpOnly: true, secure: true, sameSite: 'None', path: '/' };
    res.cookie('access_token', accessToken, { ...base, maxAge: 15 * 60 * 1000 });          // 15 min
    res.cookie('refresh_token', refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30 days
}

/**
 * Clears auth cookies on logout or when sessions need to be invalidated.
 */
function _clearAuthCookies(res) {
    const base = { httpOnly: true, secure: true, sameSite: 'None', path: '/' };
    res.clearCookie('access_token', base);
    res.clearCookie('refresh_token', base);
}

/**
 * Verifica criptográficamente el idToken de Google (cuando está presente)
 * y normaliza el payload para el servicio de autenticación.
 * Si el payload ya trae email directamente (llamada interna de confianza), lo usa tal cual.
 */
async function normalizeGoogleLoginPayload(payload) {
    const verified = await verifyGoogleIdToken(payload.idToken);

    return {
        ...payload,
        email: verified.email,
        displayName: payload.displayName || verified.name || verified.given_name || '',
        avatarUrl: payload.avatarUrl || verified.picture || null,
    };
}

export class AuthController {
    constructor({ authService, crossTenantAuthService, emailAdapter }) {
        this.authService = authService;
        this.crossTenantAuthService = crossTenantAuthService;
        this.emailAdapter = emailAdapter || null;
    }

    register = async(req, res, next) => {
        try {
            const { error, value } = registerSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            // Support both tenantIds[] (multi-tenant) and legacy tenantId (single)
            const rawIds = value.tenantIds?.length > 0
                ? value.tenantIds.map(id => id.trim()).filter(Boolean)
                : (value.tenantId?.trim() ? [value.tenantId.trim()] : []);

            // Validate all requested tenants are registered
            for (const id of rawIds) {
                const known = TENANT_CONFIGS.find(t => t.id === id);
                if (!known) return next(new ValidationError(`Institución desconocida: ${id}`));
            }

            // Check password uniqueness across all tenants before creating the account
            if (this.crossTenantAuthService && value.password) {
                const uniqueCheck = await this.crossTenantAuthService.checkPasswordUniqueness(value.password);
                if (!uniqueCheck.isFail() && !uniqueCheck.getValue().available) {
                    return next(new ConflictError('Contraseña', 'ya está en uso por otro usuario'));
                }
            }

            let result;
            if (rawIds.length > 1) {
                // Multi-tenant: register in all selected tenant databases in parallel
                result = await this.crossTenantAuthService.multiTenantRegister({ ...value, tenantIds: rawIds });
            } else {
                // Single-tenant (existing behaviour)
                const requestedTenant = rawIds[0] || null;
                if (!requestedTenant) {
                    console.warn('[AuthController] register called WITHOUT tenantId — user will be created in the default DB. Body keys:', Object.keys(value).join(', '));
                }
                const doRegister = () => this.authService.register({ ...value, tenantId: requestedTenant });
                result = requestedTenant
                    ? await runInTenantContext(requestedTenant, doRegister)
                    : await doRegister();
            }

            if (result.isFail()) return next(result.getError());
            const regData = result.getValue();
            if (regData.accessToken) _setAuthCookies(res, regData.accessToken, regData.refreshToken);
            res.status(201).json({ success: true, data: regData });
        } catch (err) { next(err); }
    };

    checkPassword = async(req, res, next) => {
        try {
            const { password } = req.body;
            if (!password) return res.json({ success: true, data: { available: true } });
            const result = await this.crossTenantAuthService.checkPasswordUniqueness(password);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    login = async(req, res, next) => {
        try {
            const { error, value } = loginSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            // Search all tenant databases in parallel so users in any institution can log in
            const result = await this.crossTenantAuthService.login(value);
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            if (!data.multipleMatches && data.accessToken) {
                _setAuthCookies(res, data.accessToken, data.refreshToken);
            }
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };
    refreshToken = async(req, res, next) => {
        try {
            // Web: refresh token from HttpOnly cookie; Mobile: from request body
            const rt = req.cookies?.refresh_token || req.body?.refreshToken;
            if (!rt) return next(new ValidationError('Refresh token requerido'));
            const result = await this.authService.refreshToken(rt);
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            _setAuthCookies(res, data.accessToken, data.refreshToken);
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    sessionLinkLogin = async(req, res, next) => {
        try {
            const { error, value } = sessionLinkSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.crossTenantAuthService.sessionLinkLogin(value.code);
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            if (!data.multipleMatches && data.accessToken) {
                _setAuthCookies(res, data.accessToken, data.refreshToken);
            }
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    changePassword = async(req, res, next) => {
        try {
            const { error, value } = changePasswordSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.authService.changePassword(req.user.userId, value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    googleLogin = async(req, res, next) => {
        try {
            const { error, value } = googleLoginSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const normalized = await normalizeGoogleLoginPayload(value);
            // Search all tenant databases in parallel so users in any institution can log in
            const result = await this.crossTenantAuthService.googleLogin(normalized);
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            if (!data.multipleMatches && data.accessToken) {
                _setAuthCookies(res, data.accessToken, data.refreshToken);
            }
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    /** Cross-tenant login: searches ALL tenant databases in parallel. */
    crossTenantLogin = async(req, res, next) => {
        try {
            const { error, value } = loginSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.crossTenantAuthService.login(value);
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            // Set cookies only for a single-match result (multiple matches need tenant selection first)
            if (!data.multipleMatches && data.accessToken) {
                _setAuthCookies(res, data.accessToken, data.refreshToken);
            }
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    /** Cross-tenant Google login: searches ALL tenant databases in parallel. */
    crossTenantGoogleLogin = async(req, res, next) => {
        try {
            const { error, value } = googleLoginSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const normalized = await normalizeGoogleLoginPayload(value);
            const result = await this.crossTenantAuthService.googleLogin(normalized);
            if (result.isFail()) return next(result.getError());
            const data = result.getValue();
            if (!data.multipleMatches && data.accessToken) {
                _setAuthCookies(res, data.accessToken, data.refreshToken);
            }
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    /** Sends a 4-digit reset code to the given email. Always responds { sent: true } for security. */
    logout = async(req, res, _next) => {
        _clearAuthCookies(res);
        res.json({ success: true, data: { message: 'Sesión cerrada' } });
    };

    /** Sends a 4-digit reset code to the given email. Always responds { sent: true } for security. */
    forgotPassword = async(req, res, next) => {
        try {
            const { error, value } = forgotPasswordSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            // Fire-and-forget: security — never reveal if email exists
            this.crossTenantAuthService.sendPasswordReset(value.email, this.emailAdapter).catch(e =>
                console.error('[AuthController] forgotPassword error (silent):', e.message)
            );
            res.json({ success: true, data: { sent: true } });
        } catch (err) { next(err); }
    };

    /** Verifies the 4-digit reset code (no password change). */
    verifyResetCode = async(req, res, next) => {
        try {
            const { error, value } = verifyResetCodeSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const valid = await this.crossTenantAuthService.verifyPasswordResetCode(value.email, value.code);
            res.json({ success: true, data: { valid } });
        } catch (err) { next(err); }
    };

    /** Resets the user password after code verification. */
    resetPassword = async(req, res, next) => {
        try {
            const { error, value } = resetPasswordSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            await this.crossTenantAuthService.resetPassword(value.email, value.code, value.newPassword);
            res.json({ success: true, data: { message: 'Contraseña actualizada correctamente' } });
        } catch (err) { next(err); }
    };
}
export default AuthController;

