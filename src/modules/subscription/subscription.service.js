import { Result } from '../../shared/Result.js';
import { NotFoundError, ConflictError } from '../../shared/errors/index.js';

export class SubscriptionDomainService {
    constructor({ subscriptionRepository, userRepository, notificationService }) {
        this.subRepo = subscriptionRepository;
        this.userRepo = userRepository;
        this.notificationService = notificationService || null;
    }

    async subscribe(subscriberId, creatorId) {
        if (subscriberId === creatorId) {
            const err = new ConflictError('No puedes suscribirte a ti mismo');
            err.silent = true;
            return Result.fail(err);
        }
        const existing = await this.subRepo.findBySubscriberAndCreator(subscriberId, creatorId);
        if (existing) return Result.ok(existing);

        try {
            const sub = await this.subRepo.create({ subscriberId, creatorId });
            this._notifyCreator(subscriberId, creatorId).catch(() => {});
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

    async _notifyCreator(subscriberId, creatorId) {
        if (!this.notificationService) return;
        const subscriber = await this.userRepo.findById(subscriberId);
        const username = subscriber?.username || 'Alguien';
        await this.notificationService.send(creatorId, {
            title: '🔔 Nuevo suscriptor',
            message: `${username} se ha suscrito a tu canal`,
            type: 'new_subscriber',
            relatedId: subscriberId,
            senderUsername: username,
            senderAvatarUrl: subscriber?.avatar || null,
            actorUserId: subscriberId
        });
    }
}
export default SubscriptionDomainService;

