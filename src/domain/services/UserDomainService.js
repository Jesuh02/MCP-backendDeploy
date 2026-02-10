import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class UserDomainService {
    constructor({ userRepository }) {
        this.userRepo = userRepository;
    }

    async getById(id) {
        const user = await this.userRepo.findById(id);
        if (!user) return Result.fail(new NotFoundError('Usuario', id));
        const { password, ...safe } = user;
        return Result.ok(safe);
    }

    async getByUsername(username) {
        const user = await this.userRepo.findByUsername(username);
        if (!user) return Result.fail(new NotFoundError('Usuario', username));
        const { password, ...safe } = user;
        return Result.ok(safe);
    }
    async updateProfile(id, data) {
        const user = await this.userRepo.findById(id);
        if (!user) return Result.fail(new NotFoundError('Usuario', id));
        const updated = await this.userRepo.update(id, data);
        return Result.ok(updated);
    }

    async search(query, limit = 20) {
        const users = await this.userRepo.searchByUsername(query, limit);
        return Result.ok(users);
    }

    async getUserRoles(userId) {
        const roles = await this.userRepo.getUserRoles(userId);
        return Result.ok(roles);
    }

    async assignRole(userId, roleId) {
        await this.userRepo.assignRole(userId, roleId);
        return Result.ok({ message: 'Rol asignado' });
    }

    async registerFCMToken(userId, token, deviceType) {
        await this.userRepo.registerFCMToken(userId, token, deviceType);
        return Result.ok({ message: 'Token registrado' });
    }

    async getByEmail(email) {
        const user = await this.userRepo.findByEmail(email);
        if (!user) return Result.fail(new NotFoundError('Usuario (email)', email));
        const { password, ...safe } = user;
        return Result.ok(safe);
    }

    async getByIds(ids) {
        const users = await this.userRepo.findByIds(ids);
        return Result.ok(users);
    }
}
export default UserDomainService;