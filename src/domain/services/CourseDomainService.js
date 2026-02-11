import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class CourseDomainService {
    constructor({ courseRepository, fileStoragePort }) {
        this.courseRepo = courseRepository;
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
}
export default CourseDomainService;