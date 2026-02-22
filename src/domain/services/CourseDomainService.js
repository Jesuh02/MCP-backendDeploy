import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository, transactionRepository, progressRepository, fileStoragePort, courseNotificationService }) {
        this.courseRepo = courseRepository;
        this.transactionRepo = transactionRepository;
        this.progressRepo = progressRepository;
        this.storage = fileStoragePort || null;
        this.courseNotificationService = courseNotificationService || null;
    }

    // Derive `isFree` flag from a price value and mutate the object provided.
    // If price > 0 => not free (premium). Otherwise it's free.
    _ensureIsFreeFlag(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (!Object.prototype.hasOwnProperty.call(obj, 'price')) return;
        const price = Number(obj.price) || 0;
        obj.isFree = price <= 0;
    }

    _validateCourseId(id) {
        const normalizedId = Number(id);
        if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
            return Result.fail(new ValidationError('courseId debe ser un entero positivo'));
        }
        return Result.ok(normalizedId);
    }

    /**
     * Sign R2 thumbnail URLs for courses so they are not blocked by private bucket.
     */
    async _signUrls(courses) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return courses;
        const list = Array.isArray(courses) ? courses : [courses];
        await Promise.all(list.map(async(c) => {
            if (!c) return;
            try {
                const url = c.thumbnail_url || c.thumbnail_uri || c.thumbnailUri;
                if (url) {
                    if (!url.includes('X-Amz-Signature')) {
                        const key = this.storage.extractObjectKey(url);
                        if (key) {
                            const signed = await this.storage.generateDownloadUrl(key, 3600);
                            c.thumbnail_uri = signed;
                            c.thumbnailUri = signed;
                            c.thumbnail_url = signed;
                        }
                    }
                }
            } catch (e) {
                console.warn('[CourseDomainService] Error signing URL for course', c.id, e.message);
            }
        }));
        return Array.isArray(courses) ? list : list[0];
    }

    async getById(id) {
        const idValidation = this._validateCourseId(id);
        if (idValidation.isFail()) return idValidation;

        const courseId = idValidation.getValue();
        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));
        await this._signUrls(course);
        return Result.ok(course);
    }

    async list(pagination) {
        const [courses, total] = await Promise.all([
            this.courseRepo.findAll(pagination),
            this.courseRepo.count({ excludeCreatorId: pagination.excludeCreatorId }),
        ]);
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

        const [total, free, premium, myCreated, otherCreators, enrolled, purchased] = await Promise.all(countPromises);

        return Result.ok({ total, free, premium, myCreated, otherCreators, enrolled, purchased });
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

    async create(courseData, requesterId) {
        courseData.creatorUserId = requesterId;
        // Ensure isFree is consistent with price (price > 0 => premium)
        this._ensureIsFreeFlag(courseData);
        const created = await this.courseRepo.create(courseData);
        
        // Fire-and-forget: Notificar a los suscriptores del creador sobre el nuevo curso
        if (this.courseNotificationService) {
            await this.courseNotificationService.notifySubscribersAboutNewCourse(created, requesterId).catch(err =>
                console.warn('[CourseDomainService] Error notifying subscribers about new course:', err.message)
            );
        }
        
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        if (course.creator_user_id && course.creator_user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para editar este curso'));
        }
        // If price is being updated, ensure isFree is consistent with new price
        this._ensureIsFreeFlag(data);
        const updated = await this.courseRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        if (course.creator_user_id && course.creator_user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para eliminar este curso'));
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


}
export default CourseDomainService;