import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';

export class CollaboratorDomainService {
    constructor({ collaboratorRepository, courseRepository, userService }) {
        this.collaboratorRepo = collaboratorRepository;
        this.courseRepo = courseRepository;
        this.notificationService = null;
        this.userService = userService || null;
    }

    setNotificationService(notificationService) {
        this.notificationService = notificationService;
    }

    setUserService(userService) {
        this.userService = userService;
    }

    async getByCourse(courseId, requesterId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        return Result.ok(await this.collaboratorRepo.findByCourse(courseId));
    }

    async add(courseId, userId, requesterId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        if (Number(course.creator_user_id) !== Number(requesterId)) {
            const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, courseId);
            if (!isCollab) return Result.fail(new ForbiddenError('Solo el creador o colaboradores pueden gestionar colaboradores'));
        }
        if (Number(course.creator_user_id) === Number(userId)) {
            return Result.fail(new ValidationError('El creador del curso no puede añadirse como colaborador'));
        }
        const collab = await this.collaboratorRepo.add(courseId, userId);

        // Notify the new collaborator (push + email)
        if (this.notificationService) {
            this._notifyCollaboratorAdded(userId, courseId, course.title, requesterId).catch(err =>
                console.error('[CollaboratorService] Error sending collaborator notification:', err?.message)
            );
        }

        return Result.ok(collab);
    }

    async remove(courseId, userId, requesterId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        if (Number(course.creator_user_id) !== Number(requesterId)) {
            const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, courseId);
            if (!isCollab) return Result.fail(new ForbiddenError('Solo el creador o colaboradores pueden gestionar colaboradores'));
        }
        await this.collaboratorRepo.remove(courseId, userId);
        return Result.ok({ message: 'Colaborador eliminado' });
    }

    async sync(courseId, userIds, requesterId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        if (Number(course.creator_user_id) !== Number(requesterId)) {
            const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, courseId);
            if (!isCollab) return Result.fail(new ForbiddenError('Solo el creador o colaboradores pueden sincronizar colaboradores'));
        }

        // Determine which users are NEW collaborators (to notify only them)
        let previousUserIds = [];
        try {
            previousUserIds = await this.collaboratorRepo.findUserIdsByCourse(courseId) || [];
        } catch { /* ignore */ }
        const previousSet = new Set(previousUserIds.map(Number));

        const filtered = (userIds || []).filter(id => Number(id) !== Number(course.creator_user_id));
        const collabs = await this.collaboratorRepo.setByCourse(courseId, filtered);

        // Notify newly added collaborators (push + email)
        if (this.notificationService) {
            const newUserIds = filtered.filter(id => !previousSet.has(Number(id)));
            for (const uid of newUserIds) {
                this._notifyCollaboratorAdded(uid, courseId, course.title, requesterId).catch(err =>
                    console.error('[CollaboratorService] Error sending sync notification:', err?.message)
                );
            }
        }

        return Result.ok(collabs);
    }

    async isCollaborator(userId, courseId) {
        return this.collaboratorRepo.isCollaborator(userId, courseId);
    }

    async isCreatorOrCollaborator(userId, courseId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(userId)) return true;
        return this.collaboratorRepo.isCollaborator(userId, courseId);
    }

    async getCollaboratorUserIds(courseId) {
        return this.collaboratorRepo.findUserIdsByCourse(courseId);
    }

    async _notifyCollaboratorAdded(userId, courseId, courseTitle, requesterId) {
        const courseName = courseTitle || 'Sin título';

        // 1. Push/in-app notification
        await this.notificationService.send(userId, {
            title: '¡Nuevo rol de colaborador!',
            message: `Has sido añadido como colaborador en el curso "${courseName}".`,
            type: 'collaborator_added',
            relatedId: courseId,
            metadata: { courseId, courseName },
            actorUserId: requesterId,
        });

        // 2. Email notification
        try {
            let userName = 'Usuario';
            let addedByUsername = 'El administrador';
            if (this.userService) {
                const [userResult, requesterResult] = await Promise.all([
                    this.userService.getById(userId).catch(() => null),
                    this.userService.getById(requesterId).catch(() => null),
                ]);
                if (userResult?.isOk?.()) userName = userResult.getValue()?.username || userName;
                if (requesterResult?.isOk?.()) addedByUsername = requesterResult.getValue()?.username || addedByUsername;
            }
            const { generateCollaboratorAddedEmailHTML } = await import('../../templates/emailTemplates.js');
            const html = generateCollaboratorAddedEmailHTML(userName, courseName, addedByUsername);
            await this.notificationService.sendEmail(userId, {
                subject: `🤝 Has sido añadido como colaborador en "${courseName}"`,
                html,
                text: `Has sido añadido como colaborador en el curso "${courseName}" por ${addedByUsername}.`,
            });
        } catch (emailErr) {
            console.warn('[CollaboratorService] Error sending collaborator email:', emailErr?.message);
        }
    }
}
export default CollaboratorDomainService;
