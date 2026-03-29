import { registerSchema, loginSchema, refreshTokenSchema, changePasswordSchema, googleLoginSchema } from './auth.schemas.js';
import { ValidationError, ConflictError } from '../../shared/errors/index.js';

function parseGoogleTokenPayload(idToken) {
    const [, payload] = idToken.split('.');
    if (!payload) throw new ValidationError('Google credential inválida');

    try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        throw new ValidationError('Google credential inválida');
    }
}

function normalizeGoogleLoginPayload(payload) {
    if (!payload.idToken || payload.email) return payload;

    const decoded = parseGoogleTokenPayload(payload.idToken);
    if (!decoded.email) throw new ValidationError('El email es requerido');

    return {
        ...payload,
        email: decoded.email,
        displayName: payload.displayName || decoded.name || decoded.given_name || '',
        avatarUrl: payload.avatarUrl || decoded.picture || null,
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

            // Check password uniqueness across all tenants before creating the account
            if (this.crossTenantAuthService && value.password) {
                const uniqueCheck = await this.crossTenantAuthService.checkPasswordUniqueness(value.password);
                if (!uniqueCheck.isFail() && !uniqueCheck.getValue().available) {
                    return next(new ConflictError('Contraseña', 'ya está en uso por otro usuario'));
                }
            }

            const result = await this.authService.register(value);
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
            const result = await this.authService.loginWithGoogle(normalizeGoogleLoginPayload(value));
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
            const result = await this.crossTenantAuthService.googleLogin(normalizeGoogleLoginPayload(value));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default AuthController;

