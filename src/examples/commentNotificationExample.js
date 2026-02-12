/**
 * EJEMPLO DE USO: Notificaciones para Comentarios y Likes
 * 
 * Este archivo muestra cómo integrar las notificaciones en tus endpoints
 * de comentarios y likes en video_comments.
 * 
 * IMPORTANTE: No ejecutar este archivo directamente, solo es referencia.
 */

import { NotificationService } from '../infrastructure/legacy/NotificationService.js';
import { SupabaseService } from '../infrastructure/database/SupabaseService.js';

const notificationService = NotificationService.getInstance();
const supabaseService = SupabaseService.getInstance();

// ============================================================
// EJEMPLO 1: Notificar cuando alguien comenta en un video
// ============================================================

/**
 * Endpoint ejemplo: POST /api/videos/:videoId/comments
 * 
 * Este endpoint debería:
 * 1. Insertar el comentario en la tabla video_comments
 * 2. Obtener información del video y su dueño
 * 3. Enviar notificación al dueño del video (si no es el mismo usuario)
 */
async function createCommentExample(req, res) {
    try {
        const { videoId } = req.params;
        const { userId, commentText } = req.body;

        // 1. Insertar comentario en la base de datos
        const { data: comment, error: commentError } = await supabaseService.client
            .from('video_comments')
            .insert({
                video_id: videoId,
                usuario_id: userId,
                comment: commentText,
                created_at: new Date()
            })
            .select()
            .single();

        if (commentError) throw commentError;

        // 2. Obtener información del video y su dueño
        const { data: video, error: videoError } = await supabaseService.client
            .from('videos')
            .select('id, title, thumbnail_uri, remote_id')
            .eq('id', videoId)
            .single();

        if (videoError) throw videoError;

        // 3. Obtener información del usuario que comentó
        const { data: commenter, error: commenterError } = await supabaseService.client
            .from('usuarios')
            .select('usuario, avatar')
            .eq('id', userId)
            .single();

        if (commenterError) throw commenterError;

        // 4. Enviar notificación al dueño del video (solo si no es el mismo usuario)
        if (video.remote_id && video.remote_id !== userId) {
            await notificationService.notifyVideoComment(
                video.remote_id, // videoOwnerId
                videoId, // videoId
                comment.id, // commentId ⭐ IMPORTANTE
                commenter.usuario, // commentAuthor
                commenter.avatar || '', // commentAuthorAvatar
                video.thumbnail_uri || '', // videoThumbnail
                commentText // commentText (opcional, para preview)
            );

            console.log(`✅ Notification sent to video owner (${video.remote_id})`);
        }

        res.status(201).json({
            success: true,
            comment: comment,
            message: 'Comentario creado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error creating comment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

// ============================================================
// EJEMPLO 2: Notificar cuando alguien da like a un comentario
// ============================================================

/**
 * Endpoint ejemplo: POST /api/comments/:commentId/like
 * 
 * Este endpoint debería:
 * 1. Registrar el like en la tabla 'likes' (entity_type='video_comment', entity_id=commentId)
 * 2. Obtener información del comentario y su autor
 * 3. Enviar notificación al autor del comentario (si no es el mismo usuario)
 */
async function likeCommentExample(req, res) {
    try {
        const { commentId } = req.params;
        const { userId } = req.body;

        // 1. Insertar like en la tabla 'likes'
        const { error: likeError } = await supabaseService.client
            .from('likes')
            .insert({
                usuario_id: userId,
                entity_type: 'video_comment',
                entity_id: commentId,
                created_at: new Date()
            });

        if (likeError) {
            // Si ya existe el like, podemos ignorar o hacer toggle
            if (likeError.code === '23505') { // Duplicate key
                return res.status(200).json({
                    success: true,
                    message: 'Ya habías dado like a este comentario'
                });
            }
            throw likeError;
        }

        // 2. Obtener información del comentario
        const { data: comment, error: commentError } = await supabaseService.client
            .from('video_comments')
            .select('id, video_id, usuario_id')
            .eq('id', commentId)
            .single();

        if (commentError) throw commentError;

        // 3. Obtener información del video (para thumbnail)
        const { data: video, error: videoError } = await supabaseService.client
            .from('videos')
            .select('thumbnail_uri')
            .eq('id', comment.video_id)
            .single();

        if (videoError) throw videoError;

        // 4. Obtener información del usuario que dio like
        const { data: liker, error: likerError } = await supabaseService.client
            .from('usuarios')
            .select('usuario, avatar')
            .eq('id', userId)
            .single();

        if (likerError) throw likerError;

        // 5. Enviar notificación al autor del comentario (solo si no es el mismo usuario)
        if (comment.usuario_id !== userId) {
            await notificationService.notifyCommentLike(
                comment.usuario_id, // commentOwnerId
                comment.video_id, // videoId
                commentId, // commentId ⭐ IMPORTANTE
                liker.usuario, // likerUsername
                liker.avatar || '', // likerAvatar
                video.thumbnail_uri || '' // videoThumbnail
            );

            console.log(`✅ Like notification sent to comment owner (${comment.usuario_id})`);
        }

        res.status(200).json({
            success: true,
            message: 'Like registrado exitosamente'
        });

    } catch (error) {
        console.error('❌ Error liking comment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

// ============================================================
// EJEMPLO 3: Notificar cuando alguien responde a un comentario
// ============================================================

/**
 * Endpoint ejemplo: POST /api/comments/:parentCommentId/reply
 * 
 * Este endpoint debería:
 * 1. Insertar la respuesta en video_comments con parent_id
 * 2. Obtener información del comentario padre y su autor
 * 3. Enviar notificación al autor del comentario padre
 */
async function replyToCommentExample(req, res) {
    try {
        const { parentCommentId } = req.params;
        const { userId, replyText } = req.body;

        // 1. Obtener información del comentario padre
        const { data: parentComment, error: parentError } = await supabaseService.client
            .from('video_comments')
            .select('id, video_id, usuario_id')
            .eq('id', parentCommentId)
            .single();

        if (parentError) throw parentError;

        // 2. Insertar respuesta en la base de datos
        const { data: reply, error: replyError } = await supabaseService.client
            .from('video_comments')
            .insert({
                video_id: parentComment.video_id,
                usuario_id: userId,
                comment: replyText,
                parent_id: parentCommentId, // ⭐ Importante para respuestas
                created_at: new Date()
            })
            .select()
            .single();

        if (replyError) throw replyError;

        // 3. Obtener información del usuario que respondió
        const { data: replier, error: replierError } = await supabaseService.client
            .from('usuarios')
            .select('usuario, avatar')
            .eq('id', userId)
            .single();

        if (replierError) throw replierError;

        // 4. Obtener información del video (para thumbnail)
        const { data: video, error: videoError } = await supabaseService.client
            .from('videos')
            .select('thumbnail_uri')
            .eq('id', parentComment.video_id)
            .single();

        if (videoError) throw videoError;

        // 5. Enviar notificación al autor del comentario padre (solo si no es el mismo usuario)
        if (parentComment.usuario_id !== userId) {
            await notificationService.notifyCommentReply(
                parentComment.usuario_id, // parentCommentOwnerId
                parentComment.video_id, // videoId
                parentCommentId, // parentCommentId
                reply.id, // replyCommentId ⭐ IMPORTANTE
                replier.usuario, // replyAuthor
                replier.avatar || '', // replyAuthorAvatar
                video.thumbnail_uri || '', // videoThumbnail
                replyText // replyText (opcional, para preview)
            );

            console.log(`✅ Reply notification sent to parent comment owner (${parentComment.usuario_id})`);
        }

        res.status(201).json({
            success: true,
            reply: reply,
            message: 'Respuesta creada exitosamente'
        });

    } catch (error) {
        console.error('❌ Error replying to comment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

// ============================================================
// EXPORT PARA USO EN RUTAS
// ============================================================

export {
    createCommentExample,
    likeCommentExample,
    replyToCommentExample
};