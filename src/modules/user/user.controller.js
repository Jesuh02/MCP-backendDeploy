import { BaseController } from '../../shared/BaseController.js';
import { updateProfileSchema, registerFCMTokenSchema, assignRoleSchema, searchUsersSchema } from './user.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';

export class UserController extends BaseController {
    constructor({ userService, whatsAppService = null }) {
        super();
        this.userService = userService;
        this.whatsAppService = whatsAppService;
    }

    /** Strips sensitive fields from a user object before returning it as another user's public profile */
    _publicUser(user) {
        if (!user || typeof user !== 'object') return user;
        const { email, emailVerified, email_verified, ...pub } = user;
        return pub;
    }

    getProfile = async(req, res, next) => {
        try {
            const userResult = await this.userService.getById(req.user.userId);
            if (userResult.isFail()) return next(userResult.getError());

            const userData = userResult.getValue();

            // Enrich profile with WhatsApp link status so the client
            // can show link/unlink UI without a separate API call.
            if (this.whatsAppService) {
                try {
                    const waResult = await this.whatsAppService.getStatus(req.user.userId);
                    if (waResult.isOk()) {
                        const wa = waResult.getValue();
                        userData.whatsapp = {
                            isLinked: wa.isLinked,
                            phoneNumber: wa.isLinked ? wa.phoneNumber : null,
                            linkedAt: wa.linkedAt || null,
                        };
                    }
                } catch (_) {
                    // non-fatal — profile returns without WA field if service fails
                }
            }

            res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
            res.json({ success: true, data: userData });
        } catch (err) {
            next(err);
        }
    };

    uploadAvatar = async(req, res, next) => {
        if (!req.file) return next(new ValidationError('No file provided'));
        this.store(req, res, next, () => this.userService.uploadAvatar(req.user.userId, req.file));
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.userService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: this._publicUser(result.getValue()) });
        } catch (err) { next(err); }
    };

    getByUsername = async(req, res, next) => {
        try {
            const result = await this.userService.getByUsername(req.params.username);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: this._publicUser(result.getValue()) });
        } catch (err) { next(err); }
    };

    updateProfile = async(req, res, next) => {
        const { error, value } = updateProfileSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.userService.updateProfile(req.user.userId, value));
    };

    search = async(req, res, next) => {
        const { error, value } = searchUsersSchema.validate(req.query);
        if (error) return next(ValidationError.fromJoi(error));
        try {
            const result = await this.userService.search(value.q, value.limit);
            if (result.isFail()) return next(result.getError());
            const data = Array.isArray(result.getValue())
                ? result.getValue().map(u => this._publicUser(u))
                : result.getValue();
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    registerFCMToken = async(req, res, next) => {
        const { error, value } = registerFCMTokenSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));

        const tokenToRegister = value.token || value.fcmToken;
        this.store(req, res, next, () => this.userService.registerFCMToken(req.user.userId, tokenToRegister, value.deviceType));
    };

    removeFCMToken = async(req, res, next) => {
        const token = req.query.fcmToken || req.query.token || req.body?.fcmToken || req.body?.token;
        if (!token) return next(new ValidationError('token requerido'));
        this.store(req, res, next, () => this.userService.removeFCMToken(req.user.userId, token));
    };

    assignRole = async(req, res, next) => {
        const { error, value } = assignRoleSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.userService.assignRole(parseInt(req.params.id), value.roleId));
    };

    getByEmail = async(req, res, next) => {
        this.store(req, res, next, () => this.userService.getByEmail(req.params.email));
    };

    getByIds = async(req, res, next) => {
        const ids = (req.query.ids || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) return res.json({ success: true, data: [] });
        try {
            const result = await this.userService.getByIds(ids);
            if (result.isFail()) return next(result.getError());
            const data = Array.isArray(result.getValue())
                ? result.getValue().map(u => this._publicUser(u))
                : this._publicUser(result.getValue());
            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    deactivateUser = async(req, res, next) => {
        const userId = parseInt(req.params.id);
        if (!userId || userId <= 0) return next(new ValidationError('userId inválido'));
        this.store(req, res, next, () => this.userService.deactivateUser(userId));
    };

    activateUser = async(req, res, next) => {
        const userId = parseInt(req.params.id);
        if (!userId || userId <= 0) return next(new ValidationError('userId inválido'));
        this.store(req, res, next, () => this.userService.activateUser(userId));
    };

    listAll = async(req, res, next) => {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;
        this.store(req, res, next, () => this.userService.listAll(limit, offset));
    };

    processExpiredCourseUsers = async(req, res, next) => {
        const { expiredCourseIds } = req.body || {};
        const ids = (expiredCourseIds || []).map(Number).filter(n => n > 0);
        this.store(req, res, next, () => this.userService.processExpiredCourseUsers(ids));
    };
}
export default UserController;