import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class UserDomainService {
    constructor({ userRepository, fileStoragePort, courseRepository = null, collaboratorRepository = null }) {
        this.userRepo = userRepository;
        this.storage = fileStoragePort;
        this.courseRepo = courseRepository;
        this._collaboratorRepo = collaboratorRepository;
        this._notificationService = null;
    }

    setNotificationService(notificationService) {
        this._notificationService = notificationService;
    }

    _normalizeRoles(roles, fallbackRoles = []) {
        const source = Array.isArray(roles) ? roles : fallbackRoles;
        return Array.isArray(source) ? source : [];
    }

    async _loadAuthoritativeRoles(userId, fallbackRoles = []) {
        if (!userId || !this.userRepo?.getUserRoles) {
            return this._normalizeRoles(fallbackRoles);
        }

        try {
            const roles = await this.userRepo.getUserRoles(userId);
            return this._normalizeRoles(roles, fallbackRoles);
        } catch (error) {
            return this._normalizeRoles(fallbackRoles);
        }
    }

    async _attachAuthoritativeRoles(user) {
        if (!user || !user.id) return user;
        const roles = await this._loadAuthoritativeRoles(user.id, user.roles || []);
        return {...user, roles };
    }

    async _attachAuthoritativeRolesToMany(users) {
        if (!Array.isArray(users) || users.length === 0) return users;
        return Promise.all(users.map((user) => this._attachAuthoritativeRoles(user)));
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
        const { password, ...unsafeSafe } = user;
        const safe = await this._attachAuthoritativeRoles(unsafeSafe);
        await this._signAvatarUrl(safe);
        return Result.ok(safe);
    }

    async getByUsername(username) {
        const user = await this.userRepo.findByUsername(username);
        if (!user) return Result.fail(new NotFoundError('Usuario', username));
        const { password, ...unsafeSafe } = user;
        const safe = await this._attachAuthoritativeRoles(unsafeSafe);
        await this._signAvatarUrl(safe);
        return Result.ok(safe);
    }
    async updateProfile(id, data) {
        const user = await this.userRepo.findById(id);
        if (!user) return Result.fail(new NotFoundError('Usuario', id));
        const updated = await this._attachAuthoritativeRoles(await this.userRepo.update(id, data));
        await this._signAvatarUrl(updated);
        return Result.ok(updated);
    }

    async search(query, limit = 20) {
        const users = await this.userRepo.searchByUsername(query, limit);
        const safeUsers = (users || []).map((user) => {
            const { password, ...rest } = user;
            return rest;
        });
        const safe = await this._attachAuthoritativeRolesToMany(safeUsers);
        await Promise.all((safe || []).map((user) => this._signAvatarUrl(user)));
        return Result.ok(safe);
    }

    async getUserRoles(userId) {
        const roles = await this._loadAuthoritativeRoles(userId);
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
        const { password, ...unsafeSafe } = user;
        const safe = await this._attachAuthoritativeRoles(unsafeSafe);
        await this._signAvatarUrl(safe);
        return Result.ok(safe);
    }

    async getByIds(ids) {
        const users = await this._attachAuthoritativeRolesToMany(await this.userRepo.findByIds(ids));
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

    /**
     * Gets validated emails for multiple users.
     */
    async getValidatedEmailsByIds(userIds = []) {
        const uniqueIds = [...new Set((userIds || []).map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))];
        if (uniqueIds.length === 0) return Result.ok([]);

        const users = await this.userRepo.findByIds(uniqueIds);
        const validated = [];

        for (const user of users || []) {
            const validation = this.validateEmail(user?.email);
            if (!validation.valid) continue;

            validated.push({
                userId: user.id,
                email: user.email,
                username: user.username || 'Usuario'
            });
        }

        return Result.ok(validated);
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

    // ─── Admin: activate / deactivate users ───────────────────────────────────

    async deactivateUser(userId) {
        const user = await this.userRepo.findById(userId);
        if (!user) return Result.fail(new NotFoundError('Usuario', userId));
        await this.userRepo.update(userId, { is_active: false });

        // Send deactivation email
        if (this._notificationService) {
            try {
                const { generateAccountStatusEmailHTML } = await import('../../templates/emailTemplates.js');
                const html = generateAccountStatusEmailHTML(user.username || 'Usuario', false);
                await this._notificationService.sendEmail(userId, {
                    subject: 'Tu cuenta en CourseV ha sido desactivada',
                    html,
                    text: `Hola ${user.username || 'Usuario'}, tu cuenta en CourseV ha sido desactivada. Si crees que es un error, contacta a soporte.`,
                });
            } catch (err) {
                console.error('[UserService] Error sending deactivation email:', err?.message);
            }
        }

        return Result.ok({ message: 'Usuario desactivado', userId });
    }

    async activateUser(userId) {
        const user = await this.userRepo.findById(userId);
        if (!user) return Result.fail(new NotFoundError('Usuario', userId));
        await this.userRepo.update(userId, { is_active: true });

        // Send activation email
        if (this._notificationService) {
            try {
                const { generateAccountStatusEmailHTML } = await import('../../templates/emailTemplates.js');
                const html = generateAccountStatusEmailHTML(user.username || 'Usuario', true);
                await this._notificationService.sendEmail(userId, {
                    subject: '¡Tu cuenta en CourseV ha sido activada!',
                    html,
                    text: `Hola ${user.username || 'Usuario'}, ¡tu cuenta en CourseV ha sido activada! Ya puedes acceder a todos los servicios.`,
                });
            } catch (err) {
                console.error('[UserService] Error sending activation email:', err?.message);
            }
        }

        return Result.ok({ message: 'Usuario activado', userId });
    }

    /**
     * List all users (admin only). Returns safe objects (no passwords).
     */
    async listAll(limit = 100, offset = 0) {
        const users = await this.userRepo.findAll({ limit, offset });
        const safeUsers = (users || []).map(u => {
            const { password, ...rest } = u;
            return rest;
        });
        const safe = await this._attachAuthoritativeRolesToMany(safeUsers);
        for (const u of safe) await this._signAvatarUrl(u);
        return Result.ok(safe);
    }

    /**
     * Process expired courses: deactivate collaborators (role 2) 
     * whose ONLY active courses have expired. courseService is used to find expired courses.
     */
    async processExpiredCourseUsers(expiredCourseIds = []) {
        let resolvedCourseIds = Array.isArray(expiredCourseIds)
            ? expiredCourseIds.map(Number).filter(n => Number.isInteger(n) && n > 0)
            : [];

        if (resolvedCourseIds.length === 0 && this.courseRepo && typeof this.courseRepo.findExpired === 'function') {
            const expiredCourses = await this.courseRepo.findExpired(new Date().toISOString()).catch(() => []);
            resolvedCourseIds = (expiredCourses || []).map((course) => Number(course.id)).filter((id) => Number.isInteger(id) && id > 0);
        }

        if (resolvedCourseIds.length === 0) return Result.ok({ deactivated: 0, expiredCourseIds: [] });

        if (this.courseRepo && typeof this.courseRepo.deactivateCourses === 'function') {
            await this.courseRepo.deactivateCourses(resolvedCourseIds).catch(() => {});
        }

        // Get all collaborator user IDs for expired courses
        let collaboratorIds = [];
        if (this._collaboratorRepo) {
            for (const courseId of resolvedCourseIds) {
                const ids = await this._collaboratorRepo.findUserIdsByCourse(courseId).catch(() => []);
                collaboratorIds = collaboratorIds.concat(ids || []);
            }
        }
        collaboratorIds = [...new Set(collaboratorIds.map(Number).filter(n => n > 0))];

        let deactivated = 0;
        for (const userId of collaboratorIds) {
            await this.userRepo.update(userId, { is_active: false }).catch(() => {});
            deactivated++;
        }

        return Result.ok({ deactivated, expiredCourseIds: resolvedCourseIds });
    }

    setCollaboratorRepo(repo) {
        this._collaboratorRepo = repo;
    }
}
export default UserDomainService;