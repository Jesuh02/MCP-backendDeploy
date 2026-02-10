import { Result } from '../../shared/Result.js';

export class LikeDomainService {
    constructor({ likeRepository }) {
        this.likeRepo = likeRepository;
    }

    async toggle(userId, entityType, entityId) {
        const existing = await this.likeRepo.findByUserAndEntity(userId, entityType, entityId);
        if (existing) {
            await this.likeRepo.delete(userId, entityType, entityId);
            const count = await this.likeRepo.countByEntity(entityType, entityId);
            return Result.ok({ liked: false, count });
        }
        await this.likeRepo.create({ userId, entityType, entityId });
        const count = await this.likeRepo.countByEntity(entityType, entityId);
        return Result.ok({ liked: true, count });
    }

    async getLikeStatus(userId, entityType, entityIds) {
        const liked = await this.likeRepo.findByUserAndEntities(userId, entityType, entityIds);
        return Result.ok(liked);
    }

    async getCount(entityType, entityId) {
        const count = await this.likeRepo.countByEntity(entityType, entityId);
        return Result.ok({ count });
    }
}
export default LikeDomainService;