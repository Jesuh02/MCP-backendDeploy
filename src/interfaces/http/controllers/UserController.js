import { updateProfileSchema, registerFCMTokenSchema, assignRoleSchema, searchUsersSchema } from '../../../domain/validators/UserSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class UserController {
    constructor({ userService }) {
        this.userService = userService;
    }

    getProfile = async(req, res, next) => {
        try {
            const result = await this.userService.getById(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    uploadAvatar = async(req, res, next) => {
        try {
            if (!req.file) return next(new ValidationError('No file provided'));
            const result = await this.userService.uploadAvatar(req.user.userId, req.file);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.userService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByUsername = async(req, res, next) => {
        try {
            const result = await this.userService.getByUsername(req.params.username);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    updateProfile = async(req, res, next) => {
        try {
            const { error, value } = updateProfileSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.userService.updateProfile(req.user.userId, value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    search = async(req, res, next) => {
        try {
            const { error, value } = searchUsersSchema.validate(req.query);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.userService.search(value.q, value.limit);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    registerFCMToken = async(req, res, next) => {
        try {
            const { error, value } = registerFCMTokenSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            
            // Support both 'token' and 'fcmToken' fields
            const tokenToRegister = value.token || value.fcmToken;
            
            const result = await this.userService.registerFCMToken(req.user.userId, tokenToRegister, value.deviceType);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    assignRole = async(req, res, next) => {
        try {
            const { error, value } = assignRoleSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.userService.assignRole(parseInt(req.params.id), value.roleId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByEmail = async(req, res, next) => {
        try {
            const result = await this.userService.getByEmail(req.params.email);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByIds = async(req, res, next) => {
        try {
            const ids = (req.query.ids || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0);
            if (ids.length === 0) return res.json({ success: true, data: [] });
            const result = await this.userService.getByIds(ids);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default UserController;