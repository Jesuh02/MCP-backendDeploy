import { registerSchema, loginSchema, refreshTokenSchema, changePasswordSchema, googleLoginSchema } from './auth.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';

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
    constructor({ authService }) {
        this.authService = authService;
    }

    register = async(req, res, next) => {
        try {
            const { error, value } = registerSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.authService.register(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
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
}
export default AuthController;

