import { Router } from 'express';

export function subscriptionRoutes({ subscriptionController }) {
    const router = Router();

    router.get('/my', subscriptionController.getMySubscriptions);
    router.get('/my/count', subscriptionController.getMyCount);
    router.get('/my/creators', subscriptionController.getMyCreators);
    router.get('/subscribers', subscriptionController.getSubscribers);
    router.get('/check/:creatorId', subscriptionController.checkSubscription);
    router.get('/count/:creatorId', subscriptionController.getCount);
    router.post('/:creatorId', subscriptionController.subscribe);
    router.delete('/:creatorId', subscriptionController.unsubscribe);

    return router;
}
export default subscriptionRoutes;