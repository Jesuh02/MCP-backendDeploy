import { Result } from '../../shared/Result.js';
import { NotFoundError, ConflictError } from '../../shared/errors/index.js';

export class SubscriptionDomainService {
    constructor({ subscriptionRepository, userRepository }) {
        this.subRepo = subscriptionRepository;
        this.userRepo = userRepository;
    }

    async subscribe(subscriberId, creatorId) {
        if (subscriberId === creatorId) {
            return Result.fail(new ConflictError('No puedes suscribirte a ti mismo'));
        }
        const existing = await this.subRepo.findBySubscriberAndCreator(subscriberId, creatorId);
        if (existing) return Result.ok(existing);

        try {
            const sub = await this.subRepo.create({ subscriberId, creatorId });
            return Result.ok(sub);
        } catch (error) {
            const message = String(error?.message || '').toLowerCase();
            const isDuplicate =
                message.includes('duplicate') ||
                message.includes('unique') ||
                message.includes('23505');

            if (isDuplicate) {
                const sub = await this.subRepo.findBySubscriberAndCreator(subscriberId, creatorId);
                if (sub) return Result.ok(sub);
            }

            throw error;
        }
    }

    async unsubscribe(subscriberId, creatorId) {
        const existing = await this.subRepo.findBySubscriberAndCreator(subscriberId, creatorId);
        if (!existing) return Result.fail(new NotFoundError('Suscripción'));
        await this.subRepo.delete(subscriberId, creatorId);
        return Result.ok({ message: 'Suscripción cancelada' });
    }

    async getSubscriptions(subscriberId) {
        const subs = await this.subRepo.findBySubscriber(subscriberId);
        return Result.ok(subs);
    }

    async getSubscribers(creatorId) {
        const subs = await this.subRepo.findByCreator(creatorId);
        return Result.ok(subs);
    }

    async isSubscribed(subscriberId, creatorId) {
        const sub = await this.subRepo.findBySubscriberAndCreator(subscriberId, creatorId);
        return Result.ok({ isSubscribed: !!sub });
    }

    async getSubscriberCount(creatorId) {
        const count = await this.subRepo.countByCreator(creatorId);
        return Result.ok(count);
    }

    async getSubscriptionCount(subscriberId) {
        const count = await this.subRepo.countBySubscriber(subscriberId);
        return Result.ok({ count });
    }

    async getSubscribedCreators(subscriberId) {
        const subs = await this.subRepo.findBySubscriber(subscriberId);
        if (!subs || subs.length === 0) return Result.ok([]);
        const creatorIds = subs.map(s => s.creator_id);
        const creators = await this.userRepo.findByIds(creatorIds);
        return Result.ok(creators);
    }

    async getSubscriberIds(creatorId) {
        const ids = await this.subRepo.findSubscriberIds(creatorId);
        return Result.ok(ids);
    }
}
export default SubscriptionDomainService;

