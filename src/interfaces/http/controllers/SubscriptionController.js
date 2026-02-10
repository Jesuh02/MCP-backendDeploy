export class SubscriptionController {
    constructor({ subscriptionService }) {
        this.subService = subscriptionService;
    }

    subscribe = async(req, res, next) => {
        try {
            const creatorId = parseInt(req.params.creatorId);
            const result = await this.subService.subscribe(req.user.userId, creatorId);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    unsubscribe = async(req, res, next) => {
        try {
            const creatorId = parseInt(req.params.creatorId);
            const result = await this.subService.unsubscribe(req.user.userId, creatorId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMySubscriptions = async(req, res, next) => {
        try {
            const result = await this.subService.getSubscriptions(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getSubscribers = async(req, res, next) => {
        try {
            const result = await this.subService.getSubscribers(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    checkSubscription = async(req, res, next) => {
        try {
            const creatorId = parseInt(req.params.creatorId);
            const result = await this.subService.isSubscribed(req.user.userId, creatorId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getCount = async(req, res, next) => {
        try {
            const result = await this.subService.getSubscriberCount(parseInt(req.params.creatorId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMyCount = async(req, res, next) => {
        try {
            const result = await this.subService.getSubscriptionCount(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMyCreators = async(req, res, next) => {
        try {
            const result = await this.subService.getSubscribedCreators(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default SubscriptionController;