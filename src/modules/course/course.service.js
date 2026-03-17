import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository, transactionRepository, progressRepository, fileStoragePort, courseNotificationService, collaboratorRepository }) {
        this.courseRepo = courseRepository;
        this.transactionRepo = transactionRepository;
        this.progressRepo = progressRepository;
        this.storage = fileStoragePort || null;
        this.courseNotificationService = courseNotificationService || null;
        this.collaboratorRepo = collaboratorRepository || null;
    }

    // Derive `isFree` flag from a price value and mutate the object provided.
    // If price > 0 => not free (premium). Otherwise it's free.
    _ensureIsFreeFlag(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (!Object.prototype.hasOwnProperty.call(obj, 'price')) return;
        const price = Number(obj.price) || 0;
        obj.isFree = price <= 0;
        obj.isPremium = price > 0;
        obj.is_premium = price > 0;
    }

    _coerceBoolean(value, fallback = true) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'si'].includes(normalized)) return true;
            if (['false', '0', 'no'].includes(normalized)) return false;
        }
        return fallback;
    }

    _readCourseActiveFlag(course) {
        return this._coerceBoolean(course?.isActive ?? course?.is_active, true);
    }

    _hasDeadlineExpired(deadline) {
        if (!deadline) return false;
        const parsed = new Date(deadline);
        return !Number.isNaN(parsed.getTime()) && parsed <= new Date();
    }

    _computeEffectiveActiveState(course) {
        if (!course) return false;
        if (!this._readCourseActiveFlag(course)) return false;
        return !this._hasDeadlineExpired(course.deadline);
    }

    _prepareCourseWriteData(data, { isCreate = false } = {}) {
        const payload = { ...(data || {}) };

        if (payload.deadline === '') {
            payload.deadline = null;
        }

        const rawIsActive = payload.isActive ?? payload.is_active;
        const desiredIsActive = rawIsActive === undefined
            ? (isCreate ? true : undefined)
            : this._coerceBoolean(rawIsActive, true);

        if (desiredIsActive !== undefined) {
            payload.isActive = desiredIsActive;
            payload.is_active = desiredIsActive;
        }

        if (payload.deadline && this._hasDeadlineExpired(payload.deadline)) {
            payload.isActive = false;
            payload.is_active = false;
        }

        return payload;
    }

    async _persistExpiredCourseState(course) {
        if (!course || !course.id || !this.courseRepo || typeof this.courseRepo.updateActiveState !== 'function') {
            return course;
        }

        if (this._readCourseActiveFlag(course) && this._hasDeadlineExpired(course.deadline)) {
            const updated = await this.courseRepo.updateActiveState(course.id, false);
            return updated || course;
        }

        return course;
    }

    _shouldRestrictInactiveAccess(requesterRoles = []) {
        const normalizedRoles = (requesterRoles || [])
            .map((role) => Number(role?.id ?? role))
            .filter((roleId) => Number.isInteger(roleId) && roleId > 0);
        if (normalizedRoles.includes(3)) return false;
        return normalizedRoles.includes(1) || normalizedRoles.includes(2);
    }

    _normalizeCourseShape(course) {
        if (!course || typeof course !== 'object') return course;

        this._ensureIsFreeFlag(course);

        const thumbnail = course.thumbnail_url || course.thumbnail_uri || course.thumbnailUri || null;
        if (thumbnail) {
            course.thumbnail_url = thumbnail;
            course.thumbnail_uri = thumbnail;
            course.thumbnailUri = thumbnail;
        }

        if (course.creator_user_id && !course.creatorUserId) {
            course.creatorUserId = Number(course.creator_user_id) || 0;
        }

        if (course.creatorUserId && !course.creator_user_id) {
            course.creator_user_id = Number(course.creatorUserId) || 0;
        }

        if (typeof course.category !== 'string' || course.category.trim().length === 0) {
            course.category = 'General';
        }

        const effectiveIsActive = this._computeEffectiveActiveState(course);
        course.is_active = effectiveIsActive;
        course.isActive = effectiveIsActive;

        if (!Object.prototype.hasOwnProperty.call(course, 'deadline')) {
            course.deadline = null;
        }

        return course;
    }

    _validateCourseId(id) {
        const normalizedId = Number(id);
        if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
            return Result.fail(new ValidationError('courseId debe ser un entero positivo'));
        }
        return Result.ok(normalizedId);
    }

    async isCreatorOrCollaborator(userId, courseId) {
        const course = await this.courseRepo.findById(courseId);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(userId)) return true;
        if (this.collaboratorRepo) return this.collaboratorRepo.isCollaborator(userId, courseId);
        return false;
    }

    /**
     * Sign R2 thumbnail URLs for courses so they are not blocked by private bucket.
     */
    async _signUrls(courses) {
        const list = Array.isArray(courses) ? courses : [courses];
        list.forEach((course) => this._normalizeCourseShape(course));
        if (!this.storage) return Array.isArray(courses) ? list : list[0];
        list.forEach((c) => {
            if (!c) return;
            const url = c.thumbnail_url || c.thumbnail_uri || c.thumbnailUri;
            if (!url) return;
            const key = this.storage.extractObjectKey(url) || url;
            const publicUrl = this.storage.getPublicUrl(key);
            c.thumbnail_uri = publicUrl;
            c.thumbnailUri = publicUrl;
            c.thumbnail_url = publicUrl;
        });
        return Array.isArray(courses) ? list : list[0];
    }

    async getById(id, requester = {}) {
        const idValidation = this._validateCourseId(id);
        if (idValidation.isFail()) return idValidation;

        const courseId = idValidation.getValue();
        let course = await this.courseRepo.findById(courseId);
        if (!course) {
            const err = new NotFoundError('Curso', courseId);
            // Missing resources are expected on client navigation retries.
            err.silent = true;
            return Result.fail(err);
        }

        course = await this._persistExpiredCourseState(course);
        this._normalizeCourseShape(course);

        if (this._shouldRestrictInactiveAccess(requester?.roles) && !this.isCourseActive(course)) {
            return Result.fail(new ForbiddenError('El curso está inactivo y no esta disponible para este rol'));
        }

        await this._signUrls(course);
        return Result.ok(course);
    }

    async list(pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findAll(pagination),
            this.courseRepo.count({ excludeCreatorId: pagination.excludeCreatorId }),
        ]);
        (courses || []).forEach((course) => this._normalizeCourseShape(course));
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async getStats() {
        const total = await this.courseRepo.count({});
        return Result.ok({ total });
    }

    /**
     * Get counts for all filter types in a single call.
     * Returns: { total, free, premium, myCreated, otherCreators, enrolled, purchased }
     * @param {number|null} userId - ID del usuario actual (para filtros relativos al usuario)
     */
    async getFilterCounts(userId) {
        const countPromises = [
            this.courseRepo.count({}), // total
            this.courseRepo.count({ isFree: true }), // free
            this.courseRepo.count({ isFree: false }), // premium (is_premium = true)
        ];

        // User-specific counts
        if (userId) {
            countPromises.push(
                this.courseRepo.count({ creatorUserId: userId }), // myCreated
                this.courseRepo.count({ excludeCreatorId: userId }), // otherCreators
            );
        } else {
            countPromises.push(Promise.resolve(0), Promise.resolve(0));
        }

        // Enrolled & Purchased counts (require user)
        if (userId && this.progressRepo) {
            countPromises.push(this.progressRepo.countEnrolled(userId)); // enrolled
        } else {
            countPromises.push(Promise.resolve(0));
        }

        if (userId && this.transactionRepo) {
            countPromises.push(this.transactionRepo.countPurchased(userId)); // purchased
        } else {
            countPromises.push(Promise.resolve(0));
        }

        const popularPromise = this.progressRepo && typeof this.progressRepo.findCourseEnrollmentRanking === 'function' ?
            this.progressRepo.findCourseEnrollmentRanking().then(r => (r || []).length) :
            Promise.resolve(0);
        countPromises.push(popularPromise);

        const [total, free, premium, myCreated, otherCreators, enrolled, purchased, popular] = await Promise.all(countPromises);

        return Result.ok({ total, free, premium, myCreated, otherCreators, enrolled, purchased, popular });
    }

    async getCreatorDashboardMetrics(creatorUserId) {
        if (!creatorUserId || Number.isNaN(Number(creatorUserId)) || Number(creatorUserId) <= 0) {
            return Result.ok({
                creatorUserId: 0,
                totalCourses: 0,
                enrolledUsersCount: 0,
                certifiedUsersCount: 0,
                completionRate: 0,
                approvalRate: 0,
                satisfactionRate: 0,
            });
        }

        const courses = await this.courseRepo.findByCreatorUserId(Number(creatorUserId), { offset: 0, limit: 10000 });
        const courseIds = (courses || []).map(c => Number(c.id)).filter(id => Number.isInteger(id) && id > 0);

        if (courseIds.length === 0) {
            return Result.ok({
                creatorUserId: Number(creatorUserId),
                totalCourses: 0,
                enrolledUsersCount: 0,
                certifiedUsersCount: 0,
                completionRate: 0,
                approvalRate: 0,
                satisfactionRate: 0,
            });
        }

        const progressRows = this.progressRepo && typeof this.progressRepo.findByCourseIds === 'function' ?
            await this.progressRepo.findByCourseIds(courseIds) : [];

        const uniqueUsers = new Set();
        const certifiedUsers = new Set();
        let completedRows = 0;
        let approvedRows = 0;

        for (const row of progressRows || []) {
            const userId = Number(row?.userId);
            if (!Number.isInteger(userId) || userId <= 0) continue;

            uniqueUsers.add(userId);

            const isCertified = Boolean(row?.certificateIssuedAt) || (typeof row?.certificateUrl === 'string' && row.certificateUrl.trim().length > 0);
            if (isCertified) certifiedUsers.add(userId);

            const progressPercentage = Number(row?.progressPercentage || 0);
            const completedTasks = Number(row?.completedTasks || 0);
            const totalTasks = Number(row?.totalTasks || 0);
            const status = String(row?.status || '').trim().toLowerCase();
            const averageGrade = Number(row?.averageGrade);

            const isCompleted = progressPercentage >= 100 || (totalTasks > 0 && completedTasks >= totalTasks);
            if (isCompleted) completedRows++;

            const isApprovedByStatus = status === 'ganado' || status === 'aprobado';
            const isApprovedByGrade = Number.isFinite(averageGrade) && averageGrade >= 6;
            if (isApprovedByStatus || isApprovedByGrade) approvedRows++;
        }

        const totalProgressRows = (progressRows || []).length;
        const completionRate = totalProgressRows > 0 ? Math.round((completedRows * 100) / totalProgressRows) : 0;
        const approvalRate = totalProgressRows > 0 ? Math.round((approvedRows * 100) / totalProgressRows) : 0;
        const satisfactionRate = Math.max(0, Math.min(100, Math.abs(approvalRate - completionRate)));

        return Result.ok({
            creatorUserId: Number(creatorUserId),
            totalCourses: courseIds.length,
            enrolledUsersCount: uniqueUsers.size,
            certifiedUsersCount: certifiedUsers.size,
            completionRate,
            approvalRate,
            satisfactionRate,
        });
    }

    async findByCreator(username, pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findByCreator(username, pagination),
            this.courseRepo.count({ creatorUsername: username })
        ]);
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async search(query, pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.search(query, pagination),
            this.courseRepo.count({ search: query })
        ]);
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async create(courseData, requesterId, requesterRoles = []) {
        const isAdmin = (requesterRoles || []).some(r => r === 3);
        if (!isAdmin) {
            return Result.fail(new ForbiddenError('Solo el rol 3 puede crear cursos'));
        }

        courseData = this._prepareCourseWriteData(courseData, { isCreate: true });
        courseData.creatorUserId = requesterId;
        // Ensure isFree is consistent with price (price > 0 => premium)
        this._ensureIsFreeFlag(courseData);
        const created = await this.courseRepo.create(courseData);
        this._normalizeCourseShape(created);

        // Fire-and-forget: Notificar a los suscriptores del creador sobre el nuevo curso
        if (this.courseNotificationService) {
            await this.courseNotificationService.notifySubscribersAboutNewCourse(created, requesterId).catch(err =>
                console.warn('[CourseDomainService] Error notifying subscribers about new course:', err.message)
            );
        }

        return Result.ok(created);
    }

    async update(id, data, requesterId, requesterRoles = []) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        const isPrivileged = (requesterRoles || []).some(r => r === 3);
        if (!isPrivileged) {
            return Result.fail(new ForbiddenError('Solo el rol 3 puede editar cursos'));
        }
        data = this._prepareCourseWriteData(data);
        this._ensureIsFreeFlag(data);
        data.lastModifiedBy = requesterId;
        const updated = await this.courseRepo.update(id, data);
        this._normalizeCourseShape(updated);
        return Result.ok(updated);
    }

    async delete(id, requesterId, requesterRoles = []) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        const isPrivileged = (requesterRoles || []).some(r => r === 3);
        if (!isPrivileged) {
            return Result.fail(new ForbiddenError('Solo el rol 3 puede eliminar cursos'));
        }
        await this.courseRepo.delete(id);
        return Result.ok({ message: 'Curso eliminado' });
    }

    async findByCreatorUserId(userId, pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findByCreatorUserId(userId, pagination),
            this.courseRepo.count({ creatorUserId: userId })
        ]);
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async findByIds(ids) {
        const courses = await this.courseRepo.findByIds(ids);
        await this._signUrls(courses);
        return Result.ok(courses);
    }

    async findFreeCourses(pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findFree(pagination),
            this.courseRepo.count({ isFree: true, excludeCreatorId: pagination.excludeCreatorId })
        ]);
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async findPremiumCourses(pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findPremium(pagination),
            this.courseRepo.count({ isFree: false, excludeCreatorId: pagination.excludeCreatorId })
        ]);
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async findPurchasedCourses(userId, pagination) {
        if (!this.transactionRepo) {
            // Fallback or empty if repo not available (though it should be)
            console.warn('TransactionRepository not injected in CourseDomainService');
            return Result.ok({ courses: [], total: 0 });
        }

        // Parallel fetch: IDs for the page, and total count
        const [courseIds, total] = await Promise.all([
            this.transactionRepo.findPurchasedCourseIdsPaginated(userId, pagination),
            this.transactionRepo.countPurchased(userId)
        ]);

        if (courseIds.length === 0) return Result.ok({ courses: [], total });

        // Fetch courses for the page IDs
        const courses = await this.courseRepo.findByIds(courseIds);

        // Retrieve order because findByIds might not preserve it
        const sortedCourses = courseIds
            .map(id => courses.find(c => c.id === id))
            .filter(c => c);

        await this._signUrls(sortedCourses);
        return Result.ok({ courses: sortedCourses, total });
    }

    async findEnrolledCourses(userId, pagination) {
        if (!this.progressRepo) {
            console.warn('ProgressRepository not injected in CourseDomainService');
            return Result.ok({ courses: [], total: 0 });
        }

        const [courseIds, total] = await Promise.all([
            this.progressRepo.findEnrolledCourseIdsPaginated(userId, pagination),
            this.progressRepo.countEnrolled(userId)
        ]);

        if (courseIds.length === 0) return Result.ok({ courses: [], total });

        const courses = await this.courseRepo.findByIds(courseIds);

        // Preserve order
        const sortedCourses = courseIds
            .map(id => courses.find(c => c.id === id))
            .filter(c => c);

        await this._signUrls(sortedCourses);
        return Result.ok({ courses: sortedCourses, total });
    }

    async findPopularCourses(pagination) {
        if (!this.progressRepo || typeof this.progressRepo.findCourseEnrollmentRanking !== 'function') {
            console.warn('ProgressRepository no soporta ranking de cursos populares');
            return Result.ok({ courses: [], total: 0 });
        }

        const offset = Number(pagination?.offset) || 0;
        const limit = Number(pagination?.limit) || 20;
        const excludeCreatorId = pagination?.excludeCreatorId ? Number(pagination.excludeCreatorId) : null;

        const ranking = await this.progressRepo.findCourseEnrollmentRanking();
        if (!ranking || ranking.length === 0) return Result.ok({ courses: [], total: 0 });

        const rankedCourseIds = ranking.map((item) => Number(item.courseId)).filter((id) => Number.isInteger(id) && id > 0);
        const enrollmentsByCourseId = new Map(ranking.map((item) => [Number(item.courseId), Number(item.enrollmentCount) || 0]));

        const allRankedCourses = await this.courseRepo.findByIds(rankedCourseIds);
        const courseById = new Map((allRankedCourses || []).map((course) => [Number(course.id), course]));

        let filteredIds = rankedCourseIds.filter((id) => courseById.has(id));
        if (excludeCreatorId && Number.isInteger(excludeCreatorId) && excludeCreatorId > 0) {
            filteredIds = filteredIds.filter((id) => Number(courseById.get(id)?.creator_user_id) !== excludeCreatorId);
        }

        const total = filteredIds.length;
        const pagedIds = filteredIds.slice(offset, offset + limit);

        const courses = pagedIds
            .map((id) => courseById.get(id))
            .filter(Boolean)
            .map((course) => ({
                ...course,
                enrollmentCount: enrollmentsByCourseId.get(Number(course.id)) || 0,
            }));

        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    /**
     * Finds courses created by a specific user that have at least one task submission.
     * Used by ChatBot context filtering.
     * @param {number} creatorUserId
     * @returns {Promise<Result>}
     */
    async findCreatorCoursesWithSubmissions(creatorUserId) {
        try {
            const courses = await this.courseRepo.findCreatorCoursesWithSubmissions(creatorUserId);
            await this._signUrls(courses);
            return Result.ok(courses);
        } catch (err) {
            return Result.fail(new Error(`Error fetching courses with submissions: ${err.message}`));
        }
    }

    /**
     * Returns all courses whose deadline has passed and are still marked published.
     * Used by the admin expiry job.
     */
    async findExpiredCourses() {
        try {
            const now = new Date().toISOString();
            const courses = await this.courseRepo.findExpired(now);
            return Result.ok(courses || []);
        } catch (err) {
            return Result.fail(new Error(`Error fetching expired courses: ${err.message}`));
        }
    }

    /**
     * Checks course is_active status — a course is "active" when deadline is null or in the future.
     */
    isCourseActive(course) {
        if (!course) return false;
        return this._computeEffectiveActiveState(course);
    }


}
export default CourseDomainService;