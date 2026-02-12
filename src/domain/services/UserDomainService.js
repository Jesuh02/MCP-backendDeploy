import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class UserDomainService {
    constructor({ userRepository, fileStoragePort }) {
        this.userRepo = userRepository;
        this.storage = fileStoragePort;
    }

    /**
     * Sign R2 avatar URLs so they are accessible (bucket is private).
     */
    async _signAvatarUrl(user) {
        if (!user || !this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return;
        if (user.avatar && !user.avatar.includes('X-Amz-Signature')) {
            const key = this.storage.extractObjectKey(user.avatar);
            if (key) {
                try {
                    user.avatar = await this.storage.generateDownloadUrl(key, 3600);
                } catch (e) {
                    console.warn('[UserDomainService] Error signing avatar URL', e.message);
                }
            }
        }
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
        await this._signAvatarUrl(safe);
        return Result.ok(safe);
    }

    async getByUsername(username) {
        const user = await this.userRepo.findByUsername(username);
        if (!user) return Result.fail(new NotFoundError('Usuario', username));
        const { password, ...safe } = user;
        await this._signAvatarUrl(safe);
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
        await this._signAvatarUrl(safe);
        return Result.ok(safe);
    }

    async getByIds(ids) {
        const users = await this.userRepo.findByIds(ids);
        if (Array.isArray(users)) {
            await Promise.all(users.map(u => this._signAvatarUrl(u)));
        }
        return Result.ok(users);
    }

    /**
     * Validates if an email is valid and usable for sending
     */
    validateEmail(email) {
        if (!email) return { valid: false, reason: 'Email vacío o nulo' };
        if (email === '.') return { valid: false, reason: 'Email placeholder "." (no configurado)' };
        if (email.startsWith('missing_email_')) return { valid: false, reason: `Email placeholder temporal: ${email}` };

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) return { valid: false, reason: `Formato de email inválido: ${email}` };

        return { valid: true, reason: null };
    }

    /**
     * Gets validated user email
     */
    async getValidatedUserEmail(userId) {
        const user = await this.userRepo.findById(userId);
        if (!user) {
            return {
                email: null,
                username: null,
                valid: false,
                reason: 'Usuario no encontrado en base de datos'
            };
        }

        const validation = this.validateEmail(user.email);
        return {
            email: validation.valid ? user.email : null,
            username: user.username || 'Usuario',
            valid: validation.valid,
            reason: validation.reason
        };
    }

    async getUserEmail(userId) {
        const user = await this.userRepo.findById(userId);
        return user ? user.email : null;
    }

    async getUsername(userId) {
        const user = await this.userRepo.findById(userId);
        return user ? user.username : null;
    }

    async getUserFCMTokens(userId) {
        try {
            const tokens = await this.userRepo.getUserFCMTokens(userId);
            return Result.ok(tokens);
        } catch (error) {
            return Result.ok([]); // Return empty on error to avoid breaking flows
        }
    }

    async removeInvalidFCMTokens(tokens) {
        try {
            await this.userRepo.removeInvalidFCMTokens(tokens);
            return Result.ok(true);
        } catch (error) {
            return Result.fail(error);
        }
    }
}
export default UserDomainService;