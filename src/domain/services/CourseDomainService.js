import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository, transactionRepository, progressRepository, fileStoragePort }) {
        this.courseRepo = courseRepository;
        this.transactionRepo = transactionRepository;
        this.progressRepo = progressRepository;
        this.storage = fileStoragePort || null;
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
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
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
        const created = await this.courseRepo.create(courseData);
        return Result.ok(created);
    }

    async update(id, data, requesterId) {
        const course = await this.courseRepo.findById(id);
        if (!course) return Result.fail(new NotFoundError('Curso', id));
        if (course.creator_user_id && course.creator_user_id !== requesterId) {
            return Result.fail(new ForbiddenError('No tienes permiso para editar este curso'));
        }
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
}
export default CourseDomainService;