import { registerSchema, loginSchema, refreshTokenSchema, changePasswordSchema, googleLoginSchema } from './auth.schemas.js';
import { ValidationError, ConflictError } from '../../shared/errors/index.js';
import { runInTenantContext, getTenantClient, TENANT_CONFIGS } from '../../config/tenantRegistry.js';
import { verifyGoogleIdToken } from './infrastructure/google-token.verifier.js';

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
    constructor({ authService, crossTenantAuthService }) {
        this.authService = authService;
        this.crossTenantAuthService = crossTenantAuthService;
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
                const doRegister = () => this.authService.register({ ...value, tenantId: requestedTenant });
                result = requestedTenant
                    ? await runInTenantContext(requestedTenant, doRegister)
                    : await doRegister();
            }

            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
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
            const result = await this.authService.login(value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    refreshToken = async(req, res, next) => {
        try {
            const { error, value } = refreshTokenSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.authService.refreshToken(value.refreshToken);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
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
            const result = await this.authService.loginWithGoogle(normalized);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** Cross-tenant login: searches ALL tenant databases in parallel. */
    crossTenantLogin = async(req, res, next) => {
        try {
            const { error, value } = loginSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.crossTenantAuthService.login(value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
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
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default AuthController;

