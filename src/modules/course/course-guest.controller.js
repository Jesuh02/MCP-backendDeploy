/**
 * CourseGuestController — OCP/SRP: thin HTTP adapter for guest-invitation actions.
 * All domain logic lives in CourseGuestService.
 */
export class CourseGuestController {
    constructor({ courseGuestService }) {
        this.guestService = courseGuestService;
    }

    /** POST /courses/:courseId/guests  — invite users */
    invite = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId, 10);
            if (!courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }

            const userIds = Array.isArray(req.body.userIds) ?
                req.body.userIds :
                req.body.userId ? [req.body.userId] : [];

            const result = await this.guestService.inviteUsers(req.user.userId, courseId, userIds);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** GET /courses/:courseId/guests  — list invited users */
    list = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId, 10);
            if (!courseId || isNaN(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, error: 'courseId must be a positive integer' });
            }
            const roles = Array.isArray(req.user.roles) ? req.user.roles.map(Number) : [];
            const result = await this.guestService.getGuests(req.user.userId, courseId, roles);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /** DELETE /courses/:courseId/guests/:userId  — remove a guest */
    remove = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId, 10);
            const guestUserId = parseInt(req.params.userId, 10);
            if (!courseId || !guestUserId || isNaN(courseId) || isNaN(guestUserId)) {
                return res.status(400).json({ success: false, error: 'courseId and userId must be positive integers' });
            }
            const result = await this.guestService.removeGuest(req.user.userId, courseId, guestUserId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}

export default CourseGuestController;
