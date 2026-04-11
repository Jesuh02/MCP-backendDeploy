/**
 * Middleware that blocks access to inactive courses for users with restricted roles (1, 2).
 * Role 3 (creator/admin) bypasses the restriction.
 *
 * @param {Object} courseRepository - Repository with findById method
 * @returns {Function} Express middleware
 */
export function createCourseActiveGuard(courseRepository) {
    return async (req, _res, next) => {
        const courseId = Number(req.params.courseId || req.params.id);
        if (!courseId || !Number.isInteger(courseId) || courseId <= 0) return next();

        const roles = (req.user?.roles || [])
            .map((r) => Number(r?.id ?? r))
            .filter((id) => Number.isInteger(id) && id > 0);

        // Role 3/4 always allowed; no roles = unauthenticated (handled by auth middleware)
        if (roles.includes(3) || roles.includes(4) || roles.length === 0) return next();

        const isRestricted = roles.includes(1) || roles.includes(2);
        if (!isRestricted) return next();

        try {
            const course = await courseRepository.findById(courseId);
            if (!course) return next(); // let the controller handle 404

            const isActive = _computeActive(course);
            if (!isActive) {
                return _res.status(403).json({
                    success: false,
                    error: 'El curso está inactivo y no está disponible para este rol',
                });
            }
        } catch {
            // On DB error, let the request through to avoid blocking everything
        }

        return next();
    };
}

function _computeActive(course) {
    const flag = course?.is_active ?? course?.isActive;
    if (flag === false || flag === 'false' || flag === 0) return false;
    if (course.deadline) {
        const d = new Date(course.deadline);
        if (!Number.isNaN(d.getTime()) && d <= new Date()) return false;
    }
    return true;
}
