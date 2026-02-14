import { sendNotificationSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError, UnauthorizedError } from '../../../shared/errors/index.js';
import { parsePagination } from '../../../shared/pagination.js';

export class NotificationController {
    constructor({ notificationService }) {
        this.notifService = notificationService;
    }

    getMyNotifications = async(req, res, next) => {
        try {
            if (!req.user || !req.user.userId) return next(new UnauthorizedError('User context missing'));
            const pg = parsePagination(req.query);
            const result = await this.notifService.getByUser(req.user.userId, pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    markAsRead = async(req, res, next) => {
        try {
            const result = await this.notifService.markAsRead(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    markAllAsRead = async(req, res, next) => {
        try {
            if (!req.user || !req.user.userId) return next(new UnauthorizedError('User context missing'));
            const result = await this.notifService.markAllAsRead(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    send = async(req, res, next) => {
        try {
            const { error, value } = sendNotificationSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            
            try {
                const result = await this.notifService.send(value.userId, {
                    title: value.title,
                    message: value.message,
                    type: value.type,
                    data: value.data,
                    relatedId: value.relatedId,
                    senderUsername: value.senderUsername,
                    senderAvatarUrl: value.senderAvatarUrl,
                    thumbnailUrl: value.thumbnailUrl,
                    metadata: value.metadata,
                });
                if (result.isFail()) return next(result.getError());
                res.status(201).json({ success: true, data: result.getValue() });
            } catch (err) {
                // Return 404 if user not found (from repository error)
                if (err.message.includes('User with ID') && err.message.includes('does not exist')) {
                     return res.status(404).json({ success: false, error: err.message });
                }
                throw err;
            }
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.notifService.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getUnreadCount = async(req, res, next) => {
        try {
            if (!req.user || !req.user.userId) {
                return next(new UnauthorizedError('User context missing'));
            }
            const result = await this.notifService.getUnreadCount(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    sendToMultiple = async(req, res, next) => {
        try {
            const { userIds, title, message, type, data } = req.body;
            if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
                return res.status(400).json({ success: false, error: 'userIds required' });
            }
            const result = await this.notifService.sendToMultiple(userIds, { title, message, type, data });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default NotificationController;

