import { Router } from 'express';

export function notificationRoutes({ notificationController, requireRoles }) {
    const router = Router();

    router.get('/my', notificationController.getMyNotifications);
    router.get('/unread-count', notificationController.getUnreadCount);
    router.put('/:id/read', notificationController.markAsRead);
    router.put('/read-all', notificationController.markAllAsRead);
    router.post('/send', requireRoles(2, 3), notificationController.send);
    router.post('/send-multiple', requireRoles(2, 3), notificationController.sendToMultiple);
    router.delete('/:id', notificationController.delete);

    return router;
}
export default notificationRoutes;