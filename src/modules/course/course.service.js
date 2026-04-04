import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository, transactionRepository, progressRepository, fileStoragePort, courseNotificationService, collaboratorRepository, userRepository }) {
        this.courseRepo = courseRepository;
        this.transactionRepo = transactionRepository;
        this.progressRepo = progressRepository;
        this.storage = fileStoragePort || null;
        this.courseNotificationService = courseNotificationService || null;
        this.collaboratorRepo = collaboratorRepository || null;
        this.userRepo = userRepository || null;
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

    _normalizeRoleIds(roles = []) {
        return [...new Set((roles || [])
            .map((role) => Number(role?.id ?? role))
            .filter((roleId) => Number.isInteger(roleId) && roleId > 0))];
    }

    async _getUserRoleIds(userId) {
        if (!userId || !this.userRepo || typeof this.userRepo.getUserRoles !== 'function') return [];
        try {
            const roles = await this.userRepo.getUserRoles(userId);
            return this._normalizeRoleIds(roles);
        } catch {
            return [];
        }
    }

    async _resolveAccessibleCourseIdsForEnrolledView(userId) {
        const numericUserId = Number(userId);
        if (!Number.isInteger(numericUserId) || numericUserId <= 0) return [];

        const roleIds = await this._getUserRoleIds(numericUserId);
        const includeEnrollmentCourses = roleIds.length === 0 || roleIds.includes(1) || roleIds.includes(2);
        const includeCollaboratorCourses = roleIds.includes(2);

        const orderedCourseIds = [];
        const seenCourseIds = new Set();
        const pushCourseId = (courseId) => {
            const normalizedCourseId = Number(courseId);
            if (!Number.isInteger(normalizedCourseId) || normalizedCourseId <= 0) return;
            if (seenCourseIds.has(normalizedCourseId)) return;
            seenCourseIds.add(normalizedCourseId);
            orderedCourseIds.push(normalizedCourseId);
        };

        if (includeEnrollmentCourses && this.progressRepo) {
            const [progressCourseIds, approvedEnrollmentCourseIds] = await Promise.all([
                typeof this.progressRepo.findEnrolledCourseIds === 'function'
                    ? this.progressRepo.findEnrolledCourseIds(numericUserId)
                    : Promise.resolve([]),
                typeof this.progressRepo.findApprovedEnrollmentCourseIds === 'function'
                    ? this.progressRepo.findApprovedEnrollmentCourseIds(numericUserId)
                    : Promise.resolve([]),
            ]);

            for (const courseId of approvedEnrollmentCourseIds || []) pushCourseId(courseId);
            for (const courseId of progressCourseIds || []) pushCourseId(courseId);
        }

        if (includeCollaboratorCourses && this.collaboratorRepo && typeof this.collaboratorRepo.findByUser === 'function') {
            const collaboratorRows = await this.collaboratorRepo.findByUser(numericUserId);
            for (const collaborator of collaboratorRows || []) {
                pushCourseId(collaborator.courseId ?? collaborator.course_id);
            }
        }

        return orderedCourseIds;
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

    /**
     * Enrich courses with creator username from users table.
     * @param {Array|Object} courses - Single course or array of courses
     * @returns {Promise<Array|Object>} Enriched courses
     */
    async _enrichWithCreatorUsername(courses) {
        if (!this.userRepo || typeof this.userRepo.findByIds !== 'function') {
            return courses;
        }

        const courseList = Array.isArray(courses) ? courses : [courses];
        if (courseList.length === 0) return courses;

        // Collect unique creator IDs that don't already have a username
        const creatorIds = [...new Set(
            courseList
                .filter(c => c && (c.creator_user_id || c.creatorUserId) && !c.creator_username && !c.creatorUsername)
                .map(c => Number(c.creator_user_id || c.creatorUserId))
                .filter(id => Number.isInteger(id) && id > 0)
        )];

        if (creatorIds.length === 0) return courses;

        try {
            const users = await this.userRepo.findByIds(creatorIds);
            const userMap = new Map((users || []).map(u => [Number(u.id), u]));

            courseList.forEach(course => {
                if (!course) return;
                const creatorId = Number(course.creator_user_id || course.creatorUserId);
                if (creatorId > 0 && !course.creator_username && !course.creatorUsername) {
                    const user = userMap.get(creatorId);
                    if (user && user.username) {
                        course.creator_username = user.username;
                        course.creatorUsername = user.username;
                        if (user.avatar) {
                            course.creator_avatar = user.avatar;
                            course.creatorAvatar = user.avatar;
                        }
                    }
                }
            });
        } catch (e) {
            console.warn('[CourseDomainService] Error enriching courses with creator username:', e.message);
        }

        return courses;
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
            // Allow users with an approved enrollment to access the course even when inactive
            let hasApprovedEnrollment = false;
            if (requester?.userId && this.progressRepo) {
                try {
                    const preEnrollment = await this.progressRepo.findPreEnrollment(requester.userId, courseId);
                    hasApprovedEnrollment = preEnrollment?.status === 'approved';
                } catch { /* ignore — treat as no enrollment */ }
            }
            if (!hasApprovedEnrollment) {
                return Result.fail(new ForbiddenError('El curso está inactivo y no esta disponible para este rol'));
            }
        }

        await this._signUrls(course);
        await this._enrichWithCreatorUsername(course);
        return Result.ok(course);
    }

    async list(pagination, requesterRoles = []) {
        const activeOnly = this._shouldRestrictInactiveAccess(requesterRoles);
        const [courses, total] = await Promise.all([
            this.courseRepo.findAll({ ...pagination, activeOnly }),
            this.courseRepo.count({ excludeCreatorId: pagination.excludeCreatorId, activeOnly }),
        ]);
        (courses || []).forEach((course) => this._normalizeCourseShape(course));
        await this._signUrls(courses);
        await this._enrichWithCreatorUsername(courses);
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
        await this._enrichWithCreatorUsername(courses);
        return Result.ok({ courses, total });
    }

    async search(query, pagination, requesterRoles = []) {
        const activeOnly = this._shouldRestrictInactiveAccess(requesterRoles);
        const [courses, total] = await Promise.all([
            this.courseRepo.search(query, { ...pagination, activeOnly }),
            this.courseRepo.count({ search: query, activeOnly })
        ]);
        (courses || []).forEach((course) => this._normalizeCourseShape(course));
        await this._signUrls(courses);
        await this._enrichWithCreatorUsername(courses);
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
        await this._enrichWithCreatorUsername(courses);
        return Result.ok({ courses, total });
    }

    async findManageableByUserId(userId) {
        const numericUserId = Number(userId);
        if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
            return Result.ok([]);
        }

        const creatorCourses = await this.courseRepo.findByCreatorUserId(numericUserId, {
            offset: 0,
            limit: 500,
            sortOrder: 'desc',
        });

        let collaboratorCourseIds = [];
        if (this.collaboratorRepo?.findByUser) {
            const collaborations = await this.collaboratorRepo.findByUser(numericUserId);
            collaboratorCourseIds = (collaborations || [])
                .map((entry) => Number(entry.course_id || entry.courseId || entry.courses?.id))
                .filter((courseId) => Number.isInteger(courseId) && courseId > 0);
        }

        const ownedIds = new Set((creatorCourses || []).map((course) => Number(course.id)).filter((id) => id > 0));
        const missingCollaboratorIds = [...new Set(collaboratorCourseIds)].filter((courseId) => !ownedIds.has(courseId));
        const collaboratorCourses = missingCollaboratorIds.length > 0
            ? await this.courseRepo.findByIds(missingCollaboratorIds)
            : [];

        const courses = [...(creatorCourses || []), ...(collaboratorCourses || [])]
            .filter((course, index, array) => array.findIndex((entry) => Number(entry.id) === Number(course.id)) === index);

        await this._signUrls(courses);
        await this._enrichWithCreatorUsername(courses);
        return Result.ok(courses);
    }

    async findByIds(ids) {
        const courses = await this.courseRepo.findByIds(ids);
        await this._signUrls(courses);
        await this._enrichWithCreatorUsername(courses);
        return Result.ok(courses);
    }

    async findFreeCourses(pagination, requesterRoles = []) {
        const activeOnly = this._shouldRestrictInactiveAccess(requesterRoles);
        const [courses, total] = await Promise.all([
            this.courseRepo.findFree({ ...pagination, activeOnly }),
            this.courseRepo.count({ isFree: true, excludeCreatorId: pagination.excludeCreatorId, activeOnly })
        ]);
        await this._signUrls(courses);
        await this._enrichWithCreatorUsername(courses);
        return Result.ok({ courses, total });
    }

    async findPremiumCourses(pagination, requesterRoles = []) {
        const activeOnly = this._shouldRestrictInactiveAccess(requesterRoles);
        const [courses, total] = await Promise.all([
            this.courseRepo.findPremium({ ...pagination, activeOnly }),
            this.courseRepo.count({ isFree: false, excludeCreatorId: pagination.excludeCreatorId, activeOnly })
        ]);
        await this._signUrls(courses);
        await this._enrichWithCreatorUsername(courses);
        return Result.ok({ courses, total });
    }

    async findPurchasedCourses(userId, pagination, requesterRoles = []) {
        if (!this.transactionRepo) {
            console.warn('TransactionRepository not injected in CourseDomainService');
            return Result.ok({ courses: [], total: 0 });
        }

        const restrictInactive = this._shouldRestrictInactiveAccess(requesterRoles);

        // Fetch all purchased IDs to filter by active state
        const [allCourseIds, rawTotal] = await Promise.all([
            this.transactionRepo.findPurchasedCourseIdsPaginated(userId, { offset: 0, limit: 10000 }),
            this.transactionRepo.countPurchased(userId)
        ]);

        if (allCourseIds.length === 0) return Result.ok({ courses: [], total: 0 });

        let filteredIds = allCourseIds;
        if (restrictInactive) {
            const allCourses = await this.courseRepo.findByIds(allCourseIds);
            const courseById = new Map((allCourses || []).map(c => [Number(c.id), c]));
            filteredIds = allCourseIds.filter(id => {
                const course = courseById.get(Number(id));
                if (!course) return false;
                this._normalizeCourseShape(course);
                return this.isCourseActive(course);
            });
        }

        const total = filteredIds.length;
        const offset = Number(pagination?.offset) || 0;
        const limit = Number(pagination?.limit) || 20;
        const pageIds = filteredIds.slice(offset, offset + limit);

        if (pageIds.length === 0) return Result.ok({ courses: [], total });

        const courses = await this.courseRepo.findByIds(pageIds);
        const sortedCourses = pageIds
            .map(id => courses.find(c => c.id === id))
            .filter(c => c);

        await this._signUrls(sortedCourses);
        await this._enrichWithCreatorUsername(sortedCourses);
        return Result.ok({ courses: sortedCourses, total });
    }

    async findEnrolledCourses(userId, pagination, requesterRoles = []) {
        if (!this.progressRepo) {
            console.warn('ProgressRepository not injected in CourseDomainService');
            return Result.ok({ courses: [], total: 0 });
        }

        const restrictInactive = this._shouldRestrictInactiveAccess(requesterRoles);
        const accessibleCourseIds = await this._resolveAccessibleCourseIdsForEnrolledView(userId);

        if (accessibleCourseIds.length === 0) return Result.ok({ courses: [], total: 0 });

        // Fetch all accessible courses first to apply active filter
        const allCourses = await this.courseRepo.findByIds(accessibleCourseIds);
        const courseById = new Map((allCourses || []).map(c => [Number(c.id), c]));

        let orderedIds = accessibleCourseIds.filter(id => courseById.has(id));
        if (restrictInactive) {
            orderedIds = orderedIds.filter(id => {
                const course = courseById.get(id);
                this._normalizeCourseShape(course);
                return this.isCourseActive(course);
            });
        }

        const total = orderedIds.length;
        const offset = Number(pagination?.offset) || 0;
        const limit = Number(pagination?.limit) || 20;
        const courseIds = orderedIds.slice(offset, offset + limit);

        if (courseIds.length === 0) return Result.ok({ courses: [], total });

        const sortedCourses = courseIds
            .map(id => courseById.get(id))
            .filter(c => c);

        await this._signUrls(sortedCourses);
        await this._enrichWithCreatorUsername(sortedCourses);
        return Result.ok({ courses: sortedCourses, total });
    }

    async findPopularCourses(pagination, requesterRoles = []) {
        if (!this.progressRepo || typeof this.progressRepo.findCourseEnrollmentRanking !== 'function') {
            console.warn('ProgressRepository no soporta ranking de cursos populares');
            return Result.ok({ courses: [], total: 0 });
        }

        const offset = Number(pagination?.offset) || 0;
        const limit = Number(pagination?.limit) || 20;
        const excludeCreatorId = pagination?.excludeCreatorId ? Number(pagination.excludeCreatorId) : null;
        const restrictInactive = this._shouldRestrictInactiveAccess(requesterRoles);

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
        if (restrictInactive) {
            filteredIds = filteredIds.filter((id) => this.isCourseActive(courseById.get(id)));
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
        await this._enrichWithCreatorUsername(courses);
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
            await this._enrichWithCreatorUsername(courses);
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