import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';

/**
 * CourseGuestService — SRP: handles all guest-invitation logic.
 *
 * A "guest" is any registered user (any role) invited directly by the course
 * creator or a collaborator. Guests receive immediate approved access without
 * going through the enrollment request flow.
 *
 * Access model: an invitation creates an `approved` pre_enrollment row so the
 * existing `findApprovedEnrollmentCourseIds` query picks it up seamlessly, giving
 * the guest access to the subjects list and course content right away.
 */
export class CourseGuestService {
    /**
     * @param {{
     *   progressRepository: import('../progress/infrastructure/supabase.progress.repository.js').SupabaseProgressRepository,
     *   courseRepository: object,
     *   userRepository: object,
     *   collaboratorRepository: object,
     *   notificationService: import('../notification/notification.service.js').NotificationDomainService | null,
     * }} deps
     */
    constructor({ progressRepository, courseRepository, userRepository, collaboratorRepository, notificationService }) {
        this.progressRepo = progressRepository;
        this.courseRepo = courseRepository;
        this.userRepo = userRepository;
        this.collaboratorRepo = collaboratorRepository;
        this.notifService = notificationService || null;
    }

    // ─── Authorization helpers ────────────────────────────────────────────────
    async _canManageGuests(requesterId, courseId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return { allowed: false, course: null };

        if (Number(course.creator_user_id) === Number(requesterId)) {
            return { allowed: true, course };
        }

        // Collaborators can also manage guests
        const isCollab = await this.collaboratorRepo.isCollaborator(requesterId, courseId);
        return { allowed: isCollab, course };
    }

    // ─── Public methods ───────────────────────────────────────────────────────
    /**
     * Invite one or more users to a course, granting immediate access.
     * Idempotent: inviting an already-invited user is a no-op for that user.
     *
     * @param {number}   requesterId - userId of the person sending the invitation
     * @param {number}   courseId
     * @param {number[]} guestUserIds - list of user IDs to invite
     */
    async inviteUsers(requesterId, courseId, guestUserIds) {
            if (!Array.isArray(guestUserIds) || guestUserIds.length === 0) {
                return Result.fail(new ValidationError('Se requiere al menos un usuario para invitar'));
        }

        const normalizedIds = [...new Set(
            guestUserIds
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
        )];
        if (normalizedIds.length === 0) {
            return Result.fail(new ValidationError('Los IDs de usuario proporcionados no son válidos'));
        }

        const { allowed, course } = await this._canManageGuests(requesterId, courseId);
        if (!allowed || !course) {
            return Result.fail(course
                ? new ForbiddenError('Solo el creador o colaboradores pueden gestionar invitados')
                : new NotFoundError('Curso', courseId)
            );
        }

        const results = [];
        for (const userId of normalizedIds) {
            if (Number(userId) === Number(requesterId)) continue; // skip self
            if (Number(userId) === Number(course.creator_user_id)) continue; // skip creator

            try {
                // Upsert pre_enrollment with approved status (immediate access)
                const row = await this.progressRepo.upsertPreEnrollment(
                    userId, courseId, 'approved', Number(requesterId)
                );

                // Also upsert a progreso_curso record so isEnrolled() returns true
                // and the course appears as enrolled in ExploreFragment / ExploreView
                try {
                    await this.progressRepo.upsert({
                        userId,
                        courseId,
                        completedTasks: 0,
                        totalTasks: 0,
                        averageGrade: 0,
                        progressPercentage: 0,
                        enrollment_status: 'activo',
                    });
                } catch (progressErr) {
                    console.warn(`[CourseGuestService] Could not create progreso_curso for userId=${userId}:`, progressErr?.message);
                }

                results.push({ userId, success: true, row });

                // Send in-app notification + email (non-blocking)
                this._notifyInvitedUser(userId, requesterId, courseId, course).catch(err =>
                    console.warn('[CourseGuestService] notification error:', err?.message)
                );
            } catch (err) {
                console.error(`[CourseGuestService] Error inviting userId=${userId}:`, err?.message);
                results.push({ userId, success: false, error: err?.message });
            }
        }

        return Result.ok({ invited: results.filter(r => r.success).length, results });
    }

    /**
     * Remove a guest from the course (revoke pre_enrollment).
     */
    async removeGuest(requesterId, courseId, guestUserId) {
        const { allowed, course } = await this._canManageGuests(requesterId, courseId);
        if (!allowed || !course) {
            return Result.fail(course
                ? new ForbiddenError('Solo el creador o colaboradores pueden eliminar invitados')
                : new NotFoundError('Curso', courseId)
            );
        }

        const existing = await this.progressRepo.findPreEnrollment(guestUserId, courseId);
        if (!existing) {
            // No formal pre-enrollment record — guest already has no approved access.
            return Result.ok({ message: 'Invitado eliminado del curso' });
        }

        // Set pre_enrollment to 'rejected' so:
        // 1. findApprovedPreEnrollments won't return them (only returns 'approved' records)
        // 2. They lose course access immediately
        // 3. They can re-request enrollment via the normal flow (requestEnrollment
        //    allows re-request when existing status is 'rejected')
        // progreso_curso is intentionally NOT modified so requestEnrollment is not
        // blocked by enrollment_status='inactivo'.
        await this.progressRepo.updateEnrollmentStatus(guestUserId, courseId, 'rejected');

        return Result.ok({ message: 'Invitado eliminado del curso' });
    }

    /**
     * List all approved pre-enrollments for a course (invited + manually approved).
     */
    async getGuests(requesterId, courseId) {
        const { allowed, course } = await this._canManageGuests(requesterId, courseId);
        if (!allowed || !course) {
            return Result.fail(course
                ? new ForbiddenError('Sin acceso para ver invitados')
                : new NotFoundError('Curso', courseId)
            );
        }

        const rows = await this.progressRepo.findApprovedPreEnrollments(courseId);
        return Result.ok(rows || []);
    }

    // ─── Notification helper ──────────────────────────────────────────────────

    async _notifyInvitedUser(userId, inviterId, courseId, course) {
        if (!this.notifService) return;

        let inviterName = 'Tu instructor';
        let inviterAvatar = null;
        try {
            const inviter = await this.userRepo.findById(inviterId);
            if (inviter) {
                inviterName = inviter.username || inviterName;
                inviterAvatar = inviter.avatar || null;
            }
        } catch { /* ignore */ }

        const courseName = course?.title || 'un curso';
        const courseThumbnail = course?.thumbnail_uri || course?.thumbnailUri || null;

        await this.notifService.send(userId, {
            title: '¡Tienes una invitación!',
            message: `${inviterName} te ha invitado al curso "${courseName}". ¡Ya tienes acceso!`,
            type: 'course_invitation',
            relatedId: courseId,
            senderUsername: inviterName,
            senderAvatarUrl: inviterAvatar,
            thumbnailUrl: courseThumbnail,
            metadata: { courseId, courseName, inviterName },
            actorUserId: inviterId,
        });

        // Email
        try {
            let guestName = 'Usuario';
            const guest = await this.userRepo.findById(userId);
            if (guest?.username) guestName = guest.username;

            const { generateCourseInvitationEmailHTML } = await import('../../templates/emailTemplates.js');
            const html = generateCourseInvitationEmailHTML(guestName, inviterName, courseName, courseThumbnail);
            await this.notifService.sendEmail(userId, {
                subject: `🎓 Tienes una invitación al curso "${courseName}"`,
                html,
                text: `Hola ${guestName}, ${inviterName} te ha invitado al curso "${courseName}" en CourseV. Ya tienes acceso completo al contenido.`,
            });
        } catch (emailErr) {
            console.warn('[CourseGuestService] Error sending invitation email:', emailErr?.message);
        }
    }
}

export default CourseGuestService;
