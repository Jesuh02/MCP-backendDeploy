/**
 * chatMessageRoutes — Rutas para mensajes de chat.
 *
 * Endpoints:
 *   GET    /my                     → mensajes del usuario autenticado
 *   GET    /session/:sessionId     → mensajes por sesión
 *   GET    /:id                    → mensaje por ID
 *   POST   /                       → crear mensaje
 *   POST   /upsert                 → upsert mensaje (crear o actualizar)
 *   DELETE /session/:sessionId     → eliminar sesión completa
 *   DELETE /:id                    → eliminar mensaje
 */
import { Router } from 'express';

export function chatMessageRoutes({ chatMessageController }) {
    const router = Router();

    router.get('/my', chatMessageController.getByUser);
    router.get('/session/:sessionId', chatMessageController.getBySession);
    router.get('/:id', chatMessageController.getById);
    router.post('/upsert', chatMessageController.upsert);
    router.post('/', chatMessageController.create);
    router.delete('/session/:sessionId', chatMessageController.deleteBySession);
    router.delete('/:id', chatMessageController.delete);

    return router;
}

export default chatMessageRoutes;

