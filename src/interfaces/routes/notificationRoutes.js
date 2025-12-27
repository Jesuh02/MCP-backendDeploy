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
        await notificationService.sendNotification(
            userId,
            '🤖 Nueva respuesta disponible',
            'Tu consulta ha sido procesada. Abre la app para ver la respuesta completa.'
        );

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error sending notification:', error);
        // Don't fail the request if notification fails, just log it
        // But return error so client knows
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
        
        await notificationService.sendNotification(
            userId,
            title,
            body
        );

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error sending push notification:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;