import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class UserDomainService {
    constructor({ userRepository, fileStoragePort }) {
        this.userRepo = userRepository;
        this.storage = fileStoragePort;
    }

    async uploadAvatar(userId, file) {
        if (!this.storage) return Result.fail(new Error('Storage service not available'));
        if (!file || !file.buffer) return Result.fail(new Error('Invalid file'));

        // Generate safe key
        const timestamp = Date.now();
        // Handle extension
        let ext = 'jpg';
        if (file.originalname) {
            const parts = file.originalname.split('.');
            if (parts.length > 1) ext = parts.pop().toLowerCase();
        } else if (file.mimetype) {
            if (file.mimetype === 'image/png') ext = 'png';
            else if (file.mimetype === 'image/jpeg') ext = 'jpg';
            else if (file.mimetype === 'image/webp') ext = 'webp';
        }

        const key = `avatars/avatar_${userId}_${timestamp}.${ext}`;

        try {
            // Upload
            const publicUrl = await this.storage.uploadFile(file.buffer, key, file.mimetype || 'image/jpeg');

            // Update user profile
            await this.userRepo.update(userId, { avatar: publicUrl });

            return Result.ok({ avatarUrl: publicUrl });
        } catch (error) {
            return Result.fail(error);
        }
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