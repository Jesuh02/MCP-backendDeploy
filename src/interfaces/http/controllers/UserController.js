import { BaseController } from './BaseController.js';
import { updateProfileSchema, registerFCMTokenSchema, assignRoleSchema, searchUsersSchema } from '../../../domain/validators/UserSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class UserController extends BaseController {
    constructor({ userService }) {
        super();
        this.userService = userService;
    }

    getProfile = async(req, res, next) => {
        this.store(req, res, next, () => this.userService.getById(req.user.userId));
    };

    uploadAvatar = async(req, res, next) => {
        if (!req.file) return next(new ValidationError('No file provided'));
        this.store(req, res, next, () => this.userService.uploadAvatar(req.user.userId, req.file));
    };

    getById = async(req, res, next) => {
        this.store(req, res, next, () => this.userService.getById(parseInt(req.params.id)));
    };

    getByUsername = async(req, res, next) => {
        this.store(req, res, next, () => this.userService.getByUsername(req.params.username));
    };

    updateProfile = async(req, res, next) => {
        const { error, value } = updateProfileSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.userService.updateProfile(req.user.userId, value));
    };

    search = async(req, res, next) => {
        const { error, value } = searchUsersSchema.validate(req.query);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.userService.search(value.q, value.limit));
    };

    registerFCMToken = async(req, res, next) => {
        const { error, value } = registerFCMTokenSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));

        const tokenToRegister = value.token || value.fcmToken;
        this.store(req, res, next, () => this.userService.registerFCMToken(req.user.userId, tokenToRegister, value.deviceType));
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
        this.store(req, res, next, () => this.userService.getByIds(ids));
    };
}
export default UserController;