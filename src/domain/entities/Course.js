/**
 * Course — Entidad de dominio para Curso.
 */
export class Course {
    constructor({
        id = null,
        title,
        description = '',
        thumbnailUri = null,
        creatorUsername = null,
        creatorUserId = null,
        isFree = true,
        price = 0,
        category = null,
        level = null,
        language = 'es',
        isPublished = true,
        subscriberCount = 0,
        createdAt = null,
        updatedAt = null,
    } = {}) {
        this.id = id;
        this.title = title;
        this.description = description;
        this.thumbnailUri = thumbnailUri;
        this.creatorUsername = creatorUsername;
        this.creatorUserId = creatorUserId;
        this.isFree = isFree;
        this.price = price;
        this.category = category;
        this.level = level;
        this.language = language;
        this.isPublished = isPublished;
        this.subscriberCount = subscriberCount;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    belongsToCreator(userId) {
        return this.creatorUserId === userId;
    }

    belongsToCreatorByUsername(username) {
        return this.creatorUsername === username;
    }

    static fromSupabaseRow(row) {
        return new Course({
            id: row.id,
            title: row.title,
            description: row.description || '',
            thumbnailUri: row.thumbnail_uri || row.thumbnailUri || null,
            creatorUsername: row.creator_username || row.creatorUsername || null,
            creatorUserId: row.creator_user_id || row.creatorUserId || null,
            isFree: row.is_free !== false,
            price: row.price || 0,
            category: row.category || null,
            level: row.level || null,
            language: row.language || 'es',
            isPublished: row.is_published !== false,
            subscriberCount: row.subscriber_count || 0,
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null,
        });
    }
}

export default Course;