import { Router } from 'express';
import { NotificationService } from '../../services/NotificationService.js';

const router = Router();
const notificationService = NotificationService.getInstance();

// Endpoint for chat response notifications (Email)
router.post('/notify-chat-response', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'UserId is required' });
        }

        // Just send a generic "new response" notification
        // We don't send the content for security/privacy
        // Use try-catch for notification logic to avoid crashing the response
        try {
            await notificationService.sendNotification(
                userId,
                '🤖 Nueva respuesta disponible',
                'Tu consulta ha sido procesada. Abre la app para ver la respuesta completa.'
            );
        } catch (notifError) {
             console.warn('⚠️ Notification failed but response handled:', notifError.message);
             // We continue to return success to the client because the MAIN action (processing) was fine.
             // The notification is secondary.
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in notify-chat-response:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint for push notifications
router.post('/send-push-notification', async (req, res) => {
    try {
        const { userId, title, body, data } = req.body;
        
        if (!userId || !title || !body) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Use the same service but potentially different method if implemented
        // For now, assuming sendNotification handles both or just email
        // If you have specific push logic, add it here
        
        await notificationService.sendPushNotification(
            userId,
            title,
            body,
            data
        );

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error sending push notification:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /notify-course-creation
 * Notifies all subscribers of a creator about a new course.
 * Called by Android app when a course is published.
 */
router.post('/notify-course-creation', async (req, res) => {
    try {
        const { creatorUserId, creatorUsername, courseId, courseTitle, courseThumbnailUrl } = req.body;

        if (!creatorUserId || !courseId) {
            return res.status(400).json({ error: 'Missing required fields (creatorUserId, courseId)' });
        }

        const result = await notificationService.notifySubscribersOfNewCourse(
            creatorUserId,
            creatorUsername || 'Un instructor',
            {
                id: courseId,
                title: courseTitle || 'Nuevo curso',
                thumbnailUri: courseThumbnailUrl
            }
        );

        res.json({ success: true, ...result });

    } catch (error) {
        console.error('❌ Error handling course creation notification:', error);
        res.status(500).json({ error: error.message, success: false });
    }
});

export default router;