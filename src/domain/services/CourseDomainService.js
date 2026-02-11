import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository, transactionRepository, fileStoragePort }) {
        this.courseRepo = courseRepository;
        this.transactionRepo = transactionRepository;
        this.storage = fileStoragePort || null;
    }

    /**
     * Sign R2 thumbnail URLs for courses so they are not blocked by private bucket.
     */
    async _signUrls(courses) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return courses;
        const list = Array.isArray(courses) ? courses : [courses];
        await Promise.all(list.map(async (c) => {
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
            this.courseRepo.count({}),
        ]);
        await this._signUrls(courses);
        return Result.ok({ courses, total });
    }

    async getStats() {
        const total = await this.courseRepo.count({});
        return Result.ok({ total });
    }

    async findByCreator(username, pagination) {
        const courses = await this.courseRepo.findByCreator(username, pagination);
        await this._signUrls(courses);
        return Result.ok(courses);
    }

    async search(query, pagination) {
        const courses = await this.courseRepo.search(query, pagination);
        await this._signUrls(courses);
        return Result.ok(courses);
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
        const courses = await this.courseRepo.findByCreatorUserId(userId, pagination);
        await this._signUrls(courses);
        return Result.ok(courses);
    }

    async findByIds(ids) {
        const courses = await this.courseRepo.findByIds(ids);
        await this._signUrls(courses);
        return Result.ok(courses);
    }

    async findFreeCourses(pagination) {
        const courses = await this.courseRepo.findFree(pagination);
        await this._signUrls(courses);
        return Result.ok(courses);
    }

    async findPremiumCourses(pagination) {
        const courses = await this.courseRepo.findPremium(pagination);
        await this._signUrls(courses);
        return Result.ok(courses);
    }

    async findPurchasedCourses(userId, pagination) {
        if (!this.transactionRepo) {
            // Fallback or empty if repo not available (though it should be)
            console.warn('TransactionRepository not injected in CourseDomainService');
            return Result.ok([]);
        }
        const courseIds = await this.transactionRepo.findPurchasedCourseIds(userId);
        if (courseIds.length === 0) return Result.ok([]);
        
        // Use findByIds but we might need to handle pagination manually if repo doesn't support it on findByIds
        // or just return all since users unlikely have > 50 courses purchased yet.
        // Assuming findByIds returns array.
        const courses = await this.courseRepo.findByIds(courseIds);
        
        // Simple manual pagination for the list of purchased courses if needed, 
        // essentially findByIds usually returns all. 
        // If strict pagination needed, would filter identifiers.
        
        await this._signUrls(courses);
        return Result.ok(courses);
    }
}
export default CourseDomainService;